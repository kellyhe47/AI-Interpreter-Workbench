---
id: 056
title: Retain output audio per run — without it the project's most distinctive finding cannot be produced
status: pending
source: spec-audit + operator (Cantonese track kept)
depends_on: []
touches: [src/client/replay/runner.ts, src/server/routes/runs.ts, src/client/components/replay/RunsList.tsx, src/client/components/replay/BlindCompare.tsx]
iterations: 0
test_files: []
branch: ""
---

## Why — this is load-bearing, not a nicety

Every run row in the UI reads **`no output audio stored`** (observed at HEAD `ca40359`, all 3 runs).

PRD §7 requires output audio be retained for later blind scoring. §10 requires scoring be
**playback-only** — *"because reading the text would let the Mandarin-pronunciation class of error
pass unnoticed."*

**With the Cantonese track kept, that stops being a design nicety and becomes the project's sharpest
result.** A TTS that does not distinguish the spoken languages reads Cantonese text aloud **in
Mandarin**: a transcript that reads perfectly and audio that is wrong. *A text-only evaluation scores
this as a success.* It is detectable only by listening — and with no stored output audio, it cannot
be produced at all.

`BlindCompare.tsx` is 446 lines with 39 tests and **has never scored anything**, because it is
playback-only by design and there is nothing to play. Quality is one of the five dimensions the
rubric's write-up must cover; it is currently structurally unreachable.

Ticket 046 built the Arm A capture path (a Web Audio tap on the inbound WebRTC media track, gated to
the model's speaking windows). **That work is landed and green but has never been exercised against a
real session** — every stored run predates it.

## What is actually missing

**The code path is landed.** Tickets 045, 046 and 048 built and pinned it end to end: upload
(`runner.ts:610-635`), route (`runs.ts:86-111`), storage (`runs/<id>.out.wav`), play gate
(`RunsList.tsx:276`), Arm A tap (`inboundAudio.ts`), Replay-only wiring
(`browserDeps.inboundTap.test.ts`). What is missing is that **no run has ever exercised it**: all 3
runs in `data/runs/` are `origin: "manual"` with `outputAudioPath` absent, and all 3 predate 046.

So this is a **wiring-verification + real-data ticket**, not a build ticket. Its criteria are
written against bytes on disk and against a blind-compare pair that plays, not against units that
are already green.

## Acceptance criteria

> already satisfied: "A completed run that produced audio stores it, and `GET /api/runs/:id/audio`
> returns it" — landed by 045 and pinned by `src/server/routes/runs.audioUpload.test.ts:77` and
> `src/client/replay/runner.outputAudio.test.ts:235`. Do not rebuild it.

> already satisfied: "Both arms: cascade from the TTS stream, Arm A via 046's inbound tap" — the
> Arm A tap is constructed and wired into `buildReplayDeps`, pinned on the CONSTRUCTED TRANSPORT
> (not on a source-string grep) by `src/client/browserDeps.inboundTap.test.ts`, and driven
> end-to-end by `src/client/replay/replayArmA.test.ts`.

> already satisfied: "Replay still autoplays nothing" — `src/client/audio/inboundAudio.test.ts:397`
> asserts the tap's only path to `ctx.destination` is a gain pinned at 0. Keep it green; do not
> re-assert it.

> already satisfied: "Live still persists NO audio (§17 19h)" — `browserDeps.inboundTap.test.ts`
> asserts the tap is absent from `buildBrowserDeps`. Keep it green; do not re-assert it.

- [ ] **At least one NEW run on disk carries `outputAudioPath`** and a non-empty
      `data/runs/<id>.out.wav` exists for it. (Today: 0 of 3.)
- [ ] **A stored Arm A run** and **a stored Arm B (or C) run** each carry a non-empty
      `.out.wav` — the two arms are verified separately because they capture through completely
      different code paths (data-channel PCM vs. the WebRTC media tap).
- [ ] **Every stored `.out.wav` header reads 24000 Hz, 1 channel, 16-bit** — checkable with
      `readWav` on the bytes, so blind compare cannot tell the arms apart by format.
- [ ] **The Arm A file is not mostly silence.** Falsifiable form: for the SAME Recording, the stored
      Arm A `.out.wav` duration is no more than 2× the stored cascade `.out.wav` duration, and is
      strictly less than the Recording's own `durationMs`. (A 45 s file for a ~21 s recording means
      046's speaking-window gate did not hold on real audio.)
- [ ] **Blind compare can play an Arm A vs Arm B pair** of the same Recording — both play buttons
      fire and a score is written to `data/comparisons.jsonl`.
- [ ] **Blind compare can play an EN→YUE pair.** This needs a YUE Recording, and `data/recordings/`
      currently holds only 3 EN takes. If no YUE take exists at execution time, record one first or
      cut this criterion explicitly — do not silently skip it.

## The operator check this ticket exists to enable

Once audio is retained, listen to an EN→YUE cascade output and confirm whether the TTS speaks
Cantonese or Mandarin. **That single listen is the finding.** No test can produce it.

## Out of scope

- **Do not change Live.** Live persists no audio and creates no Run records (§17 19h). If a change
  makes `buildBrowserDeps` construct an inbound TAP, it is wrong — Live's inbound track goes to
  `remoteAudioSink` (an autoplaying element) and nowhere else.
- **Do not change autoplay behaviour anywhere.** Replay autoplays nothing; Live autoplays always.
- **Do not add a second upload path, a second play gate, or a second "has audio" predicate.**
  `Run.outputAudioPath !== undefined` at `RunsList.tsx:276` is the one gate.
- **Do not change the failure verdict.** A failed or hung upload leaves the run `complete`, keeps
  every timing, POSTs the Run, leaves `outputAudioPath` unset and pushes the reason onto
  `run.errors` (045/048). Do not "improve" this into a run failure.
- **Do not touch cost, WER, arm derivation, or the ledger's aggregation gate.**
- **No new test file** — see below.
- Blind-scoring *methodology* (rater counts, rubric wording) is not this ticket; this ticket only
  makes a pair playable.

## Golden eval
`eval/golden/12-output-audio-is-retained-for-blind-scoring.json`

## CONTEXT FOR A FRESH AGENT

### 1. Verified facts and citations

| Claim | Verified |
| --- | --- |
| No run has stored audio | true — all 3 files in `data/runs/` have no `outputAudioPath`; `data/runs/` contains no `*.out.wav` |
| All stored runs are manual | true — `origin: "manual"`; armTags A(failed), B(complete), A(complete) |
| Upload path in the runner | `src/client/replay/runner.ts:610-635` (`uploadOutputAudio`), called at `1140-1147`, assigned at `1190` |
| Audio buffer | `src/client/replay/runner.ts:833` (`audioChunks`), pushed at `898`, Arm A tap fallback at `1049-1051`, concatenated at `1108` |
| `POST /api/runs/:id/audio` | `src/server/routes/runs.ts:92-111` |
| `GET /api/runs/:id/audio` | `src/server/routes/runs.ts:86-90` |
| Storage layout | `src/server/storage/index.ts:256` (`runAudioStorePath`), `:397` (`writeRunAudio`), `:402` (`readRunAudio`); path is `runs/<id>.out.wav` (`src/server/storage/test-support.ts` `LAYOUT.runWav`) |
| `SAMPLE_RATE` | `src/core/protocol.ts:47` — `export const SAMPLE_RATE = 24000;` |
| Arm A tap rate is DERIVED | `src/client/audio/inboundAudio.ts:67` — `export const INBOUND_SAMPLE_RATE = SAMPLE_RATE;` |
| `BlindCompare.tsx` | 446 lines; `BlindCompare.test.tsx` 842 lines / 39 `it(` blocks (ticket previously said 34 — corrected) |
| Play gate | `src/client/components/replay/RunsList.tsx:276` |
| "no output audio stored" is not a literal | the UI renders a short marker (`RunsList.tsx` `NO_AUDIO`); do not grep for the sentence |

### 2. The code, inline

`src/client/replay/runner.ts:610-635` — the upload, bounded, and non-fatal:

```ts
async function uploadOutputAudio(args: {
  runs: RunsClient; id: string; outputAudio: Int16Array; skip: boolean; errors: string[];
}): Promise<string | undefined> {
  if (args.skip || args.outputAudio.length === 0) return undefined;
  try {
    const uploaded = await withDeadline(
      () => args.runs.uploadAudio(args.id, writeWav(args.outputAudio, SAMPLE_RATE)),
      AUDIO_UPLOAD_TIMEOUT_MS,
    );
    if (uploaded === DEADLINE) { args.errors.push(`output audio upload failed: no response within ${AUDIO_UPLOAD_TIMEOUT_MS} ms`); return undefined; }
    return uploaded.outputAudioPath;
  } catch (cause) { args.errors.push(`output audio upload failed: ...`); return undefined; }
}
```

`src/server/routes/runs.ts:86-111` — the two routes:

```ts
router.get('/api/runs/:id/audio', (req, res) => {
  handleAsync(res, async () => { sendWav(res, await storage.readRunAudio(req.params.id!)); });
});

router.post('/api/runs/:id/audio', parseJson, (req, res) => {
  const { audioBase64 } = (req.body ?? {}) as { audioBase64?: unknown };
  if (typeof audioBase64 !== 'string') { sendBadRequest(res, 'invalid-run-audio', 'audioBase64 must be a base64 string'); return; }
  if (audioBase64.length === 0) { sendBadRequest(res, 'invalid-run-audio', 'audioBase64 must not be empty'); return; }
  handleAsync(res, async () => {
    const bytes = new Uint8Array(Buffer.from(audioBase64, 'base64'));
    await storage.writeRunAudio(req.params.id!, bytes);
    res.status(201).json({ id: req.params.id!, outputAudioPath: runAudioStorePath(req.params.id!), bytes: bytes.length });
  });
});
```

`src/client/components/replay/RunsList.tsx:274-277` — the ONE play gate:

```tsx
// TICKET 045 — stored audio, not status, decides the play control.
const hasAudio = run.outputAudioPath !== undefined;
```

`src/client/replay/runner.ts:1049-1051` — the Arm A fallback that makes the tap reach the upload:

```ts
if (audioChunks.length === 0) {
  const captured = ...;
  if (captured !== undefined && captured.length > 0) audioChunks.push(captured);
}
```

### 3. Existing tests — where assertions must land

STANDING POLICY: no new test file may be added to a module that already has one. Every module this
ticket touches already has one, so **this ticket adds NO new test file.**

- Runner / upload behaviour → `src/client/replay/runner.outputAudio.test.ts` (10 `it(` blocks,
  lines 235-410). Any new runner assertion goes HERE.
- Server route → `src/server/routes/runs.audioUpload.test.ts` (lines 77, 104, 127, 144).
- REST client → `src/client/replay/recordingsClient.uploadAudio.test.ts`.
- Play gate → `src/client/components/replay/RunsList.playGate.test.tsx`.
- Blind compare UI → `src/client/components/replay/BlindCompare.test.tsx`.
- Arm A tap unit → `src/client/audio/inboundAudio.test.ts`; wiring →
  `src/client/browserDeps.inboundTap.test.ts`; end-to-end →
  `src/client/replay/replayArmA.test.ts`.
- Storage layout → `src/server/storage/runs.test.ts:81` (`writeRunAudio` / `readRunAudio`).

### 4. Seams / injectable dependencies

jsdom has no `AudioContext`, `MediaStream` or `RTCPeerConnection`, so everything is injected. The
ones this ticket needs:

- `src/client/browserDeps.ts` — `BrowserDeps extends SessionDeps` at **line 94**.
  `buildReplayDeps` (line 258) constructs the inbound tap **lazily** at lines 343-344 and passes it
  to `ReplayDeps.createTransport`; `buildBrowserDeps` (line 441) is Live and must NOT.
  `remoteAudioSink` (declared line 116, built line 289 with `{ muted: true }`) is Live's audible
  path and belongs to the browser bag, not to `SessionDeps`.
- `createInboundAudioTap({ audioContextFactory })` in `src/client/audio/inboundAudio.ts:148` —
  the factory is the AudioContext seam; called exactly once, eagerly, with
  `{ sampleRate: INBOUND_SAMPLE_RATE }`.
- `RunsClient.uploadAudio(id, wavBytes)` — `src/client/replay/recordingsClient.ts:115`, real impl
  at `:388`. This is the upload seam `runner.outputAudio.test.ts` fakes.
- `transport.outputAudioStats?.()` — `src/client/replay/runner.ts:1090`, the capture-gate
  diagnostic seam.
- `src/server/storage/test-support.ts` — `LAYOUT.runWav(base, id)` = `runs/<id>.out.wav`, and every
  storage test runs against a fresh `mkdtemp` dir so nothing is written into the repo.
- `src/server/providers/test-support.ts` — `FakeWsBase` for the cascade WS path.
- `src/client/views/sessionTestKit.ts` and `src/client/fixtureDeps.ts` (`buildFixtureDeps`,
  `isFixtureMode`) — needed only if a UI-level test is added; note fixture runs are deliberately
  non-aggregatable.
- `src/client/components/results/testRecords.ts`, `src/client/state/hydrationFixtures.ts` — not
  needed for this ticket.

### 5. Golden evals this ticket must satisfy

- `eval/golden/12-output-audio-is-retained-for-blind-scoring.json` — **the binding one.** Requires
  `outputAudioPath` on a complete run, `blind_compare_playable_pairs: 1`, and no
  `"no output audio stored"`.
- `eval/golden/08-replay-is-paced-at-1x.json` — a capture/tap change must not alter pacing: 1047
  frames for a 20 940 ms recording, wall clock within 10%.
- `eval/golden/09-live-intervals-are-anchored-and-commensurable.json` — read it before touching
  anything shared with Live; this ticket must leave Live's intervals untouched.
- `eval/golden/06-fixture-and-placeholder-never-aggregate.json` — a fixture transport must not
  start producing "real" stored audio that reaches a figure.

### 6. Known traps for THIS ticket

- **A fix that satisfies the test seam while production has zero callers.** This exact failure
  already happened here: 046's first version asserted `browserDeps.ts` source contained the string
  `createInboundAudioTap`, which the IMPORT LINE alone satisfied — the reviewer deleted the whole
  property from `buildReplayDeps` and 1726/1726 stayed green. There is no lint script. Assert on the
  CONSTRUCTED TRANSPORT, never on a source-string grep.
- **A wiring seam delivered incidentally by an unrelated re-render.** Blind compare's play controls
  gate on `run.outputAudioPath`; a test that fabricates a Run object with the field set proves
  nothing about whether a real run ever stores it. The falsifiable check is bytes in `data/runs/`.
- **A guard bypassed by a cast or a `!`.** `req.params.id!` and `audioBase64 as string` are both
  live in `runs.ts`; do not add another.
- **RTL appends.** `BlindCompare.test.tsx` accessors use `document.querySelector`; a second render
  in the same test compares a render against itself. Scope queries to the returned container.
- **The silence trap.** An Arm A capture with the gate stuck OPEN produces a 45 s file that passes
  every "audio exists" assertion and is useless for scoring. An Arm A capture with the gate stuck
  SHUT produces the `CAPTURE_GATE_NEVER_OPENED` diagnostic (`runner.ts:1090-1106`) — which rides
  `errors`, NOT `status`, so the run still counts. Check both directions on real bytes.
- **`SAMPLE_RATE` must stay the single literal.** `INBOUND_SAMPLE_RATE` is derived from it; do not
  introduce a second `24000`.
- **A failed upload must not become a failed run.** Aggregation gates on `status === 'complete'`
  and never on `errors`; flipping the status would silently delete good latency samples.

### Standing project rules

- `isAggregatableRun` is the ONE place that decides aggregation — never add a second gate.
- Arm membership is DERIVED from configuration, never declared.
- Unmeasured is `null` and renders `not measured` — never `$0.00`, never a zero.
- Never report a fixture-sourced number; never aggregate a run whose `origin` is `manual` or
  `status` is `failed`.
- The measured atom is the UTTERANCE, not the Run.
- 24 kHz PCM16 mono everywhere; `SAMPLE_RATE` in `src/core/protocol.ts` is the single source of truth.
- Live persists no audio and creates no Run records.
- Replay autoplays nothing; Live autoplays always.
