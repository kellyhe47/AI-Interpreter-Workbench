---
id: 051
title: Live shows no timings at all — speech_end is never stamped, and first_audio_delta does not exist over WebRTC
status: green
source: operator
depends_on: []
touches: [src/client/transport/realtime.ts, src/client/transport/cascade.ts, src/client/views/useSessionController.ts, src/client/views/LiveView.tsx, src/core/timing.ts]
iterations: 0
test_files: []
branch: ""
---

## Observed

A real Realtime (Arm A) Live session, English -> Spanish. The utterance COMPLETED — source
transcript rendered, target transcript rendered, card status `ready`, footer `1 utterances`. And
every figure is blank:

```
endpointing        —
model  opaque      —
queue              —
total —                                   3 intervals · 1 opaque
1 utterances    p50 —    p95 —    session $0.00
```

Operator: *"The metric should show right here, as the model picks and translates an utterance. I see
nothing… we just need to be able to see these metrics about timings and cost counts per translation
as one speaks live."*

## Root cause — TWO independent gaps, which together blank every row

`deriveRealtimeIntervals` (`src/core/timing.ts`) computes:
```
endpointing = server_speech_stopped − speech_end
model       = first_audio_delta     − server_speech_stopped
queue       = audio_queued          − first_audio_delta
endToEnd    = audio_queued          − speech_end
```

**1. `speech_end` is NEVER stamped in Live.** Grep across `src/client`: the only emitters are
`fixtureDeps.ts`, `transport/fixture.ts` and `sessionTestKit.ts` — all fixtures. In REPLAY it comes
from the corpus manifest (`trueSpeechEndMs`, handled at `replay/runner.ts:577`). Live has no
manifest and no VAD-derived substitute; there is no speech-end signal anywhere in `audio/capture.ts`
or `session/router.ts`. So `endpointing` and `endToEnd` are null — **and `endToEnd` is the headline
number, which is why the footer p50/p95 are blank too** (`ledger.aggregates` derives latency as
`audio_queued − speech_end`).

**2. `first_audio_delta` does not exist over WebRTC.** Ticket 040 established this empirically:
`response.output_audio.delta` is NOT PRESENT on the WebRTC transport; the model's audio arrives on
the media track only. `realtime.ts:594` emits `first_audio_delta` from that event, so for Arm A it
never fires. `model` and `queue` are therefore null by construction.

Both gaps are structural, not flaky. Nothing intermittent about it.

## NOT affected — state this in the write-up

**Replay measurements are correct.** Replay gets `speech_end` from the corpus manifest, so every
experimental number — the arms comparison, p50/p95, WER, cost — is unaffected. This is a LIVE
DISPLAY defect. Live is explicitly not experimental evidence (§17 19h, and the view says so).

## A MEASUREMENT-DESIGN DECISION IS REQUIRED — do not let an implementer pick silently

`speech_end` in Replay means *the operator-annotated instant the human stopped speaking* — ground
truth from the corpus. **Live has no ground truth**, so "endpointing" cannot mean the same thing.
The options are not equivalent:

- **(a) Derive `speech_end` as `server_speech_stopped − silence_duration_ms`.** Circular: endpointing
  then renders the pinned 500 ms constant on every utterance and measures nothing.
- **(b) Client-side energy/VAD detection on the mic stream.** An independent estimate, but a second
  endpointer whose disagreements with the server's would be indistinguishable from real variance —
  and AGENTS.md pins VAD as a measurement control, not a knob.
- **(c) Measure from an event Live can actually observe.** Drop the pretence of true endpointing in
  Live and anchor the headline on `server_speech_stopped -> audio_queued`, labelled for what it is
  (response latency from VAD stop, not from speech end).

**(c) is the recommended default** — it is honest, needs no new signal, and is the only one that
measures something real in Live. It must be LABELLED differently from Replay's endToEnd so the two
are never compared as if they were the same quantity.

## Acceptance criteria

- [ ] A real Live utterance renders NON-BLANK per-stage figures for both arms, as it completes
- [ ] The footer's `p50` / `p95` / `session $` populate from real Live utterances
- [ ] **Arm A's `model` interval derives from an event that EXISTS over WebRTC** —
      `audio_queued − server_speech_stopped` — never from `first_audio_delta`
- [ ] `queue` is structurally unobservable for Arm A over WebRTC. Render it as **unavailable and say
      why** (the existing `opaque` treatment is the precedent), NOT as a dash that reads as a bug
- [ ] Whatever Live's headline latency is anchored on, it is **labelled distinctly from Replay's**,
      and the label states the anchor. Two different quantities must not share one name.
- [ ] Cascade Live renders its stage rows too — confirm whether `cascade.ts`'s pass-through timings
      already cover it, and fix if not
- [ ] **Replay is untouched.** `speech_end` from the corpus manifest still drives every experimental
      figure; no aggregate moves. Pin this — a regression here corrupts the actual experiment.
- [ ] Cost per utterance is visible live (the footer's `session $` already sums it; confirm it
      populates rather than sitting at $0.00)

## Out of scope

Per-turn history within a session and a past-sessions list — the operator explicitly does not need
stored audio or session history here. This ticket is only about the CURRENT utterance's figures
being real. File separately if wanted.

---

## DECIDED (operator) — option (c), and the labels must speak for themselves

### The measurement anchor: (c)
Live anchors on what it can actually observe: **`server_speech_stopped` -> `audio_queued`**. No
back-derived `speech_end`, no second client-side VAD. Rationale recorded above; (a) is circular and
(b) adds a second endpointer whose disagreements with the server's would be indistinguishable from
real variance, against AGENTS.md's rule that VAD is a measurement control, not a knob.

### CONSEQUENCE — Live must STOP RENDERING `endpointing` entirely
Endpointing is *the gap between when the human actually stopped speaking and when the system decided
they had*. Measuring it requires ground truth for the former, which only the corpus manifest has.
**Live has none, so the row can never hold a value.** Do not relabel it, do not dash it — remove it
from Live. A row that is structurally incapable of a value is worse than no row: it reads as
breakage forever.

Same reasoning retires Arm A's separate `queue` row. Over WebRTC there is no observable instant
between "model produced audio" and "audio queued" — 040 settled that `response.output_audio.delta`
does not exist on this transport. One observable span means ONE row.

### THE LABELLING RULE — every row names the two events it spans
The operator's objection, verbatim: *"the metrics that are currently displayed kind of don't mean
anything. What does end-pointing mean? I just want to make sure that these metrics speak for
themselves in what they are measuring."*

`endpointing`, `model`, `queue` are jargon that mean nothing without a glossary. **Every stage row
must state its span**, so it needs no legend and cannot be confused with Replay's differently-
anchored figure.

**Live · Arm A (Realtime)** — one row, because one model does everything:
```
model  (opaque)   detected end of speech -> audio ready        1.24 s
```
The existing `opaque` treatment stays, and its note stays true: recognition, translation and voice
happen inside one model, so no finer split is observable.

**Live · Cascade** — the same span, broken into the stages it CAN see:
```
transcribe   detected end of speech -> transcript      0.31 s
translate    transcript -> translated text             0.22 s
speak        text -> audio ready                       0.48 s
total                                                  1.01 s
```

**Replay keeps `endpointing`** — there it is real, because the manifest supplies ground truth. But
it gets the same treatment: state the span rather than assume the reader knows the term.

### Additional acceptance criteria (these SUPERSEDE the earlier list where they conflict)

- [ ] Live renders NO `endpointing` row and no Arm A `queue` row — removed, not blanked
- [ ] Every Live stage row names the two events it spans, in plain language, with no glossary needed
- [ ] Live's headline total is labelled distinctly from Replay's end-to-end, and the label states the
      anchor — the two are different quantities and must never share a name
- [ ] Arm A's single row derives from `audio_queued - server_speech_stopped`, never from
      `first_audio_delta` (which does not exist over WebRTC)
- [ ] Cascade Live renders `transcribe` / `translate` / `speak` from real marks. **Verify whether
      `cascade.ts`'s pass-through timings already supply them; if a mark is missing, that is part of
      this ticket.**
- [ ] Per-utterance COST is visible as the utterance completes — the footer's `session $` must
      accumulate rather than sit at `$0.00`
- [ ] The footer's `p50` / `p95` populate from real Live utterances under the new anchor
- [ ] **REPLAY IS UNTOUCHED IN SUBSTANCE.** Its figures still derive from the manifest's
      `speech_end`; no aggregate moves, no gate changes. Only its stage LABELS may change. Pin this
      — a regression here corrupts the actual experiment.

### Note for the test-writer — a likely locked-test conflict
Existing tests almost certainly pin the strings `endpointing`, `model`, `queue` and the
`[data-stage-row="<label>"]` hooks, in both Live and Replay suites. **Survey the whole suite before
writing** and resolve it in the test-writer's own pass; an implementer hitting a locked-vs-locked
conflict on label text is a wasted dispatch. If the Replay relabelling turns out to be substantially
more invasive than the Live work, say so and it will be split into its own ticket rather than
allowed to stall this one.

---

## ROUND 2 — code review of `ef7c204`

The anchor fallback was verified clean (`speech_end` always wins — mutating that fails 4 tests
including both GUARD cases; no Replay aggregate moves; `first_audio_delta` is not in the chain and
cannot rescue a record). `speech_stopped` in the STT provider is safe — no exhaustive switch exists,
the turn-final contract still holds, and an empty-text `speech_stopped` provably does not finalise
a turn. Live still creates no Runs and persists no audio. Seven of the label/span/merge mutations
all fail. **Three MAJOR problems remain.**

### R2-1 (MAJOR) — `audio_queued` IS NOT THE SAME EVENT IN THE TWO ARMS, and the `speak` span deletes the only mark that could reconcile them
`orchestrator.ts:47,309` — cascade: `timings.audio_queued = Date.now(); // updated per chunk => last
chunk wins` — the **LAST** TTS byte.
`realtime.ts:599` — Arm A: stamped **ONCE** from `output_audio_buffer.started` — the **FIRST** audio.

So `total from detected end of speech` is **time-to-FIRST-audio on Arm A and time-to-LAST-audio on
cascade**. Cascade's figure scales with utterance length (synthesis duration); Arm A's does not.
Ticket 051 newly renders both under ONE label on the same card, pools both into
`ledger.aggregates()` p50/p95, and writes both into `LiveSession.latency` -> Results.

Concrete harm: a 2-word Arm A session (0.9 s) beside a long-sentence cascade session (3.4 s) reads
as *"cascade is ~4x slower"*. Most of that delta is playout duration of a longer utterance.

**And my `speak` design call was wrong.** `mt_first_token -> audio_queued` absorbs `tts_first_byte`,
which the server DOES stamp (`orchestrator.ts:307`) and which is the ONLY mark from which cascade's
time-to-first-audio — the quantity commensurable with Arm A's — can be recovered. My justification
("names no event the operator can reason about") does not survive contact with `RunsList.tsx`, which
already renders that row in Replay. It also costs an observable interval against PRD §8's
"5 vs 3 — the auditability gap, quantified", for no gain.
`exportResults.ts:308` already documents latency as "to the **first** byte of output audio being
queued" — which cascade's `audio_queued` is not. The repo's own definitions already disagree.

**DECIDED:** four cascade rows — `transcribe`, `translate`, `synthesize` (`mt_first_token ->
tts_first_byte`, *"translated text -> audio starts"*), `deliver` (`tts_first_byte -> audio_queued`,
*"audio starts -> audio complete"*) — and the **HEADLINE becomes `tts_first_byte - vad_fired`**, so
both arms' totals measure time-to-first-audio and are comparable. `deliver` stays visible as its own
row; it is real information, just not the headline.

### R2-2 (MAJOR) — the anchor fix stops at LiveView; Results now publishes a wrong-statistic Live p50
`derive.ts:1043`. `deriveLiveModel` still reads `u.timings?.speech_end`, which **Live never has**, so
`samples` is ALWAYS empty and the column falls through to `meanOf(sessions.map(s => s.latency.p50))`
— a *mean of per-session p50s*, not a pooled nearest-rank percentile.
Before 051 that branch produced `null` and the column was blank. **After 051 `saveLiveSession`
yields real numbers, so Results begins publishing an endpointer-anchored figure, computed by the
wrong statistic, immediately beside Replay's corpus-anchored p50, with no anchor label anywhere in
`ResultsView`.** This ticket's entire thesis, violated one file over.
Both directions are vacuous today: forcing the fallback (`if (true || …) return null`) leaves
1927/1927 green, and switching it to the anchored rule ALSO leaves 1927/1927 green.
**DECIDED:** `deriveLiveModel` uses `anchoredLatencyMs`; delete the mean-of-p50s fallback (or keep it
only as an explicitly-degraded path); carry `from detected end of speech` onto the Results Live card.

### R2-3 (MAJOR) — ROUTED TO TICKET 052, not fixed here
The Arm A meter adds `cached_tokens * cachedIn` **on top of** `audio_tokens * audioIn`. In OpenAI's
`response.done`, `input_token_details.cached_tokens` is a **SUBSET** of the tokens already counted in
`audio_tokens`/`text_tokens`. Cached input is meant to be re-priced DOWN from $32/M to $0.40/M; this
bills it at **$32.40/M — 80x the correct rate, and it makes the cached case cost MORE**, inverting
the effect PRD §17 24b names as a **Large**-impact confound. Deleting the term outright leaves
1927/1927 green.
Also: `textIn: 4` / `textOut: 16` appear **nowhere in the PRD** (they match OpenAI's public card, but
the repo cannot show that), and no test pins any absolute USD figure — only ratios.
**052 now owns this**: its implementer is replacing this local meter with the shared `pricing.ts`
module. The subset-aware formula is `audioIn * (audio_tokens - cached_audio_tokens) + cachedIn *
cached_audio_tokens` (same for text) — **but the subset semantics must be confirmed against a real
`response.done` before it is trusted.**

### R2-4 (MINOR) — `speechEndSource: 'vad'` is now a FALSE CLAIM on every Live record
`useSessionController.ts:490`, `orchestrator.ts:366`. PRD §7: *"`speech_end` is corpus ground truth in
benchmark runs and VAD-derived in live sessions; the record marks which."* Option (c) deliberately
never stamps `speech_end` in Live, yet every Live record still declares it VAD-sourced. No consumer
reads it today — but it is a persisted, EXPORTED field asserting a mark that does not exist.
**DECIDED:** add a third value (`'none'`) and reconcile PRD §7.

### R2-5 (MINOR) — card and footer can disagree under one label
`anchoredLatencyMs` prefers `speech_end`; the interval derivations never read it. A record carrying
both marks renders card-total `audio_queued - vad_fired` and footer-p50 `audio_queued - speech_end`
— two numbers, one label. `fixtureDeps.ts:148` emits exactly such records (card 0.55 s vs footer
1.05 s); it does not bite only because fixture records fail `isRealRecord`.
**DECIDED:** the view uses the same anchor `anchoredLatencyMs` chose.

### R2-6 (MINOR) — `aggregates()` with no runId is now an anchor-mixing pool
`ledger.ts:933`. Every in-app caller passes a runId and Replay's figures come from
`runAggregates()`, so **nothing shipped moves** — but the no-arg form now pools corpus-anchored and
endpointer-anchored samples into one p50. Document it, or refuse to mix.

### R2-7 (MINOR) — Arm A's single bar is always 100% wide. Drop the bar column when `rows.length === 1`.

### DEFERRED TO 052 (already its AC)
The footer now sums metered dollars with unmeasured zeros, so `session $0.03` over five utterances
can mean "three measured, two silently contributed nothing". 052 makes cost nullable and adds the
`n of m metered` disclosure.
