---
id: 051
title: Live shows no timings at all — speech_end is never stamped, and first_audio_delta does not exist over WebRTC
status: pending
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
