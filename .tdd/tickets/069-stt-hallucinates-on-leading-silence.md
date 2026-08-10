---
id: 069
title: "The STT hallucinates on leading silence — give it the source language and stop sending it the silence"
status: done
source: operator sweep, 2026-08-09 (the upstream half of ticket 068)
depends_on: [068]
touches: [src/server/providers/openai-stt.ts, src/server/providers/elevenlabs-stt.ts, src/server/ws.ts, src/core/models.ts, src/client/replay/runner.ts]
iterations: 1
test_files: []
branch: main
---

## Why

Ticket 068 made the corruption loud. This one stops it happening.

Across the operator's 17 sweep runs the FIRST stored source text was:

```
10x  "No, none at all."   <- correct, manifest idx1
 1x  "Turn right."          1x  "그러나."        1x  "Hallo."
 1x  "żeśmy."               1x  "Yardımımın"     1x  "Telephone"     1x  "Ok."
```

Korean, German, Polish, Turkish — the textbook Whisper-family hallucination on non-speech audio,
firing on the clip's opening silence in roughly **7 of 17 runs**. Each occurrence consumed segment 0,
shifted every real utterance one slot later, and dropped the last one.

After 068 those runs fail loudly instead of lying quietly — which means **~40% of every sweep is now
wasted** until this is fixed. It is the last thing between the operator and a sweep whose numbers can
be reported.

## Root cause — the SAME shape as ticket 062, one stage over

`resolveTriple` (`src/core/models.ts`, called from `src/server/ws.ts`) builds every provider from
`{ model }` alone. So:

- `OpenAiSttConfig` (`src/server/providers/openai-stt.ts:53-57`) is `{ apiKey, model }` — **there is
  no language field at all**, and the OpenAI transcription session is opened without one.
- `ElevenLabsSttConfig` **already has** `languageCode?` (`elevenlabs-stt.ts:90-91`), already appends
  `&language_code=` to the URL (`:144`) and already puts it on the config frame (`:225`) — and
  **nothing ever sets it.**

`session.start` carries `languagePair`, `direction` and `targetLanguage` (ticket 062) but **no source
language**. The session knows which way it is running; the STT is never told.

This is ticket 062's exact defect one stage upstream: *the adapter has a knob, the session has the
answer, and nothing connects them.*

## ⚠️ THE CONSTRAINT THAT MAKES SILENCE-TRIMMING DANGEROUS

**Do NOT trim the clip.** The runner's `t0` is frame 0 of the paced audio, and every manifest anchor
is `t0 + trueSpeechEndMs`. Removing leading samples shifts the audio against the anchors and silently
invalidates **every latency measurement in the project** — a far worse bug than the one being fixed,
and one that would look like a small consistent improvement rather than an error.

**Trim TRANSMISSION, not time.** The pacer must keep pacing at 1× with `t0` and the frame clock
untouched; what changes is that leading frames below a silence threshold are **not sent to the
provider** until speech onset. The STT then never sees the silence it hallucinates on, and every
anchor still means exactly what it meant before.

Golden eval 08 pins Replay at 1× pacing — it must stay green, and it is the check that the clock did
not move.

## Acceptance criteria

**The language hint**

- [ ] `session.start` carries the **source** language (derived from `direction`, never declared
      separately — `en→es` means the source is English)
- [ ] It reaches the STT adapter through `resolveTriple`'s options, exactly as ticket 062 routed
      `targetLanguage` to the MT adapter. Falsifiable per adapter: the value on the wire (URL query
      or config frame for ElevenLabs; the transcription-session payload for OpenAI) names the source
      language, per direction — `en→es` sends English, `es→en` sends Spanish
- [ ] `OpenAiSttConfig` gains the field and actually sends it; `ElevenLabsSttConfig`'s existing
      `languageCode` is finally populated rather than left undefined
- [ ] A session that names **no** direction sends **no** language hint — absent, never a guessed
      default. Guessing `en` would be this project's characteristic sin in a new place.

**The transmission trim**

- [ ] Leading frames below a silence threshold are not transmitted; transmission begins at speech
      onset
- [ ] **`t0`, the pacing clock and every manifest anchor are UNCHANGED.** Falsifiable: a run over a
      clip with N ms of leading silence produces per-utterance `speech_end` values identical to the
      same clip with the trim disabled
- [ ] Pacing stays 1× — golden eval 08 green
- [ ] A clip with **no** leading silence transmits from frame 0, byte-for-byte as today
- [ ] The trim never removes speech: assert on a clip whose first utterance begins immediately

**The proof**

- [ ] A test reproduces the failure shape — leading silence, then speech — and asserts the STT
      received no audio before onset, so it had nothing to hallucinate on

## Out of scope

- Ticket 068's detection (done — keep it green; a hallucination that still gets through must still
  fail loudly).
- Cost metering (ticket 053), the audio seams, re-running the sweep.
- Changing the segmenter, the manifest, or `trueSpeechEndMs`.
- Live mode: the operator speaks into a live mic, so there is no leading-silence clip to trim. The
  language hint may still apply; the trim does not.

## Notes

- The hallucination is intermittent (7 of 17), so a test that runs the pipeline once and sees clean
  output proves nothing. Pin the **inputs** — what reached the provider — not the provider's output.
- Both halves are independently valuable: the hint alone should stop the foreign-language outputs;
  the trim alone removes the audio that triggers them. Ship both, and pin them separately so a
  future regression in one is not masked by the other.

## RESOLUTION (2026-08-09)

Suite 2491 passing / 0 failing. `npm run check` exits 0. Golden eval 08 (Replay paced at 1×) green.

**The hint.** `resolveTriple(triple, { sourceLanguage })` adds `languageCode` to `stt.options` only,
real vendors only, key omitted when absent. `sourceLanguageOfDirection` lives in `core/protocol.ts`
beside the frame field it derives from; it requires exactly two non-empty halves around `→` and
returns the left one lowercased. `OpenAiSttConfig.languageCode` is new and reaches
`session.audio.input.transcription.language`. **`elevenlabs-stt.ts` needed no change at all** — its
wire half already worked; only the `resolveTriple` link was missing, which is exactly what the ticket
predicted.

Derived, never declared: `ws.ts` reads only `msg.direction`, so a frame carrying its own
`sourceLanguage` is structurally ignored, and no field was added to `ClientToServerMessage`. An
unparseable direction (`''`, no arrow, `en→`) sends **no key at all** — never a guessed `'en'`.

**The trim, and the constraint that made it dangerous.** The pacer is still handed the **whole clip**
— no `subarray`, no offset, no new anchor — and `t0` still precedes `createPacer`. The withholding
happens inside `onFrame`: `frameIndex` counts frames of the *original* clip and frames below
`skippedFrames` return without calling `transport.sendAudio`. Withheld frames are **dropped, never
shifted**, so frame *k* stays due at `t0 + k · FRAME_MS` and the run still spans a full clip-length.
`createPacer` is byte-for-byte unchanged, which is why eval 08 is untouched.

`SILENCE_PEAK_AMPLITUDE = 256` (≈ −42 dBFS), **peak** rather than mean/RMS, deliberately conservative
in one direction: leaving a near-silent frame in costs a little hallucination risk, while withholding
a frame carrying the first phoneme corrupts the transcript. A wholly silent clip returns `0` rather
than transmitting nothing, so a silent recording is a lost measurement and not a lost run.

### The mutation that mattered

The orchestrator replaced the transmission-trim with a **clip-trim** (`samples.subarray(...)`) — the
exact failure the ticket was written to prevent, which would improve every latency by precisely the
silence removed and look like a small consistent gain rather than an error.

It was caught: *"expected 200 to be less than or equal to 1"* — the first transmitted frame would
have departed 200 ms early. **Only the frame-departure assertion caught it**; the `speech_end`
equality did not, because `speech_end` is `t0 + trueSpeechEndMs` either way. That is exactly why the
test-writer built two independent pins instead of one, and it is the reason this ticket is safe.

### Still upstream, still true

This reduces the hallucination; it does not make the provider incapable of it. Ticket 068's
segment-count detection remains the backstop — a hallucination that still gets through fails loudly
rather than shifting every utterance one slot.
