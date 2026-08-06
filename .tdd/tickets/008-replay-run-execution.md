---
id: 008
title: Replay run execution — recording → pacer → transport → Run record
status: pending
depends_on: [001, 003, 007]
touches: [src/client/replay/runner.ts, src/client/replay/runner.test.ts, src/client/replay/recordingsClient.ts, src/client/replay/recordingsClient.test.ts, src/client/transport/fixture.ts, src/client/transport/fixture.test.ts]
iterations: 0
test_files: []
branch: ""
---

## Scope

The client-side machinery that turns *"this Recording, this configuration"* into a persisted
`Run`. No React, no UI — ticket 013 renders on top of this.

- **ADD `src/client/replay/runner.ts`** — executes ONE run: fetch the Recording's audio, feed
  it through the ticket-007 pacer into the selected transport, collect transcripts + per-stage
  timings + output audio, and produce a `Run` record.
- **ADD `src/client/replay/recordingsClient.ts`** — a thin typed client over the ticket-003
  REST endpoints (`fetch` injected, never captured globally).
- **MODIFY `src/client/transport/fixture.ts`** — the fixture transport must serve **Replay**
  (fed from a Recording) as well as Live, so the whole Replay path is exercisable in tests and
  in `?fixture=1` browser QA without spending a cent.

## Design constraints (PRD §7, §8)

- **`armTag` is derived**, via `deriveArmTag` — the runner never accepts a caller-supplied tag.
- **`origin: 'manual'`** for a single triggered run. The batch runner (ticket 009) is the only
  producer of `origin: 'sweep'`.
- **Replay context is pinned to zero, always, both architectures** — a control, not a choice
  (PRD §8 tier 1, §17 21c). The runner does not accept a context-policy argument.
- **`speechEndMs` comes from the Recording**, computed once from the waveform and stored, so
  `t0` is identical across every Run of it. The runner never re-derives it per run.
- **Nothing autoplays in Replay** (PRD §7). The run buffers its output audio and reports
  `ready`; playback is on demand and does **not** move the `audio_queued` timestamp —
  "first audio out" is stamped when the first sample is decoded and queued, the instant it
  *would* begin sounding.
- Realtime runs are orchestrated client-side and the Run record is POSTed back; cascade runs
  ride the WS path. Both produce the same `Run` shape.
- A run that loses a stage is saved with `status: 'failed'` plus the failing stage — real
  information, excluded from aggregates by the ledger, never silently dropped.

## Acceptance criteria

- [ ] `runOnce({recordingId, config})` fetches the recording audio once and paces it through
      the ticket-007 pacer — the transport receives **480-sample frames on a 20 ms schedule**,
      not one big buffer (assert against the pacer's schedule, not just frame count)
- [ ] The produced `Run` carries `recordingId`, `architecture`, `providerTriple`,
      `modelSnapshots`, timings, transcripts, cost and `createdAt`
- [ ] `armTag` on the produced Run equals `deriveArmTag(config)`; a caller-supplied `armTag`
      is ignored
- [ ] `origin` is `'manual'` for `runOnce`
- [ ] `status` is `'complete'` on the happy path
- [ ] A transport error mid-run produces `status:'failed'` with the failing stage recorded,
      the Run is still POSTed and stored, and `runOnce` resolves rather than throwing
- [ ] The run's `speechEndMs`/`t0` is taken from the Recording, not recomputed — two runs of
      the same Recording share an identical `t0`
- [ ] Nothing plays automatically: the runner never calls into playback; it exposes the
      buffered output audio for on-demand play
- [ ] Cancelling a run in flight stops pacing promptly and does not POST a bogus complete Run
- [ ] `recordingsClient` covers list / get / get-audio / create / patch-label / delete and
      surfaces a 409 on corpus delete and a 404 on unknown id as typed errors, not throws of
      raw `Response`
- [ ] An unplayable Recording (audio missing) blocks a new run **before** it starts, rather
      than failing mid-flight (PRD §12)
- [ ] The fixture transport can be driven from a Recording and produces a well-formed
      utterance timeline (source partials → final, target deltas → final, timing marks, audio)
      with **fixture-named providers**, so records it produces are excluded by the ledger's
      realness rule

## Orchestrator note — realtime model snapshot (added after ticket 001)

`REALTIME_MODEL` is `gpt-realtime` (Arm A's frozen recipe, which the rubric requires), but the
existing transport and token defaults are `gpt-realtime-mini` — the PRD §5 / §14 **development**
model, chosen for cost control. `deriveArmTag` therefore tags a mini-model run `ad-hoc`, and that
is **correct**: a cheap dev run must not count as Arm A evidence. That is the quarantine working.

The consequence to handle here: **this ticket must pass the realtime model explicitly from the run
configuration** rather than letting the transport fall back to its dev default — otherwise every
realtime run derives `ad-hoc` and Arm A never appears in the ledger. `src/server/token.ts` and
`src/client/transport/realtime.ts` keep `gpt-realtime-mini` as their default; the caller supplies
`REALTIME_MODEL` for measured runs.

## Test plan

New `src/client/replay/runner.test.ts` + `recordingsClient.test.ts` (jsdom), fake clock and
injected `fetch`. Extend `src/client/transport/fixture.test.ts`. **No network.**

## Attempt log
