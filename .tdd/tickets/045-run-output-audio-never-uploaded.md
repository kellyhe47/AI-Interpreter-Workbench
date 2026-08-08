---
id: 045
title: Run output audio is never uploaded — the play button 404s and blind compare has nothing to play
status: green
source: qa-live
depends_on: []
touches: [src/server/routes/runs.ts, src/client/replay/recordingsClient.ts, src/client/replay/runner.ts, src/client/components/replay/RunsList.tsx]
iterations: 0
test_files: [src/server/routes/runs.audioUpload.test.ts, src/client/replay/recordingsClient.uploadAudio.test.ts, src/client/replay/runner.outputAudio.test.ts, src/client/components/replay/RunsList.playGate.test.tsx]
branch: ""
---

## Repro

Operator ran their recorded corpus clip through Cascade and Realtime. Both runs **completed**
(4 utterances each, real `audio_queued`). Pressing **play** on a run card does nothing.

```
GET /api/runs/<id>/audio  ->  404 {"code":"run-audio-missing"}
```

…for every run, cascade and realtime alike.

## Root cause

The READ path exists and the WRITE path was never built.

- `runOnce` computes `outputAudio` and returns it with `audioReady: outputAudio.length > 0`
  (`src/client/replay/runner.ts` ~521, ~587) — and **never uploads it**.
- `src/server/routes/runs.ts` has `POST /api/runs`, `GET /api/runs`,
  `GET /api/runs/:id/audio` — **no upload route at all**.
- `RunsClient` has `getAudio` and **no upload method**.
- `storage.writeRunAudio` exists and is called only from a test.
- `Run.outputAudioPath` is populated only in test fixtures, never in production.

## A design constraint that must not be got wrong

**The audio must NOT ride in the `POST /api/runs` body.** That route stores the body verbatim, and
`appendRun` writes the whole Run object as ONE LINE of `ledger.jsonl`. Base64 audio in that body
would put megabytes into every ledger line and destroy the append-only history's readability.

It needs its **own endpoint**, e.g. `POST /api/runs/:id/audio`, following the recordings precedent
for how bytes cross the wire.

## Scope note — this fixes CASCADE only

Ticket 046 covers Arm A. After 040/043 realtime audio arrives on the WebRTC **media track**, and
`onAudio` fires only from `response.output_audio.delta`, which does not exist over WebRTC — so for
Arm A `audioChunks` is empty and there is nothing to upload even with this route in place. Do not
"fix" that here by faking it.

## Acceptance criteria

- [x] **ORDERING CORRECTED — my AC was wrong.** The upload happens BEFORE the Run is POSTed, and
      the Run carries the path the upload REPORTED. Uploading after would leave a Run in an
      append-only ledger with no PATCH promising audio that a failed upload never wrote — and the
      play control gates on exactly that field, so it would offer a 404 button. `outputAudioPath`
      is a report, not a promise. The route therefore accepts an upload for a not-yet-POSTed Run.
- [ ] A run that produced output audio uploads it, and
      `GET /api/runs/:id/audio` then returns those exact bytes
- [ ] The audio does **NOT** travel in the `POST /api/runs` body — assert the ledger line stays
      small and carries no base64
- [ ] A **cancelled** run uploads nothing (it POSTs no Run either)
- [ ] A **failed** run still uploads whatever audio it produced — a failed run is real information
      (PRD §12) and its partial audio is diagnostic
- [ ] A run that produced NO audio uploads nothing and does not create an empty file
- [ ] **The play control is gated on audio actually existing, not on `status === 'complete'`.** A
      control that cannot act must not look actionable — the same principle as tickets 024 and 044.
      An Arm A run (no audio until 046) must not offer a play button that 404s.
- [ ] An upload failure does not fail the Run — the measurement is already recorded and is the
      valuable artifact; surface it without discarding the run
- [ ] Audio stays 24 kHz PCM16 mono; `Run.outputAudioPath` reflects reality when set

## Notes

- Storage already has `writeRunAudio` and the route layer already has `sendWav` — this is mostly
  wiring, plus the play-control gate.
- Nothing autoplays in Replay (PRD §7): the upload must not cause playback, and no `AudioContext`
  may be constructed at render.

## Attempt log

- Green in one implementation pass, 17 red -> 0. Suite 1699/99; both tsconfigs clean; build clean.
- New `POST /api/runs/:id/audio` (own endpoint, `{ audioBase64 }` -> `201 { id, outputAudioPath,
  bytes }`, code `invalid-run-audio`). It VALIDATES before touching the store — the recordings
  discipline, not the runs pass-through one — so a rejected upload provably creates no file.
- `runAudioStorePath(runId)` exported from storage so the PRD §7 layout is spelled ONCE, in storage,
  and the route reports it. The client never invents a path.

### The ticket's ordering was WRONG and the test-writer caught it

My AC said "upload AFTER the Run is POSTed". The ledger is append-only with no PATCH, so a Run
POSTed first can never be corrected when the upload fails: it would sit in history promising audio
that was never written, and the play control gates on exactly that field, so it would offer a 404
button. **Inverted: upload FIRST, then POST the Run carrying the path the upload reported.**
`outputAudioPath` is a REPORT, not a promise — which is why the route must accept an upload for a
not-yet-POSTed Run, now pinned by its own test.

### The play-gate rule changed, deliberately

Ticket 013 pinned `[data-run-play]` to "complete only". That was a PROXY for "has audio" and is
wrong in **both** directions: a complete Arm A run stores no audio and was offering a button that
404s (the 024/044 defect exactly), while a failed run that synthesized output before losing a stage
keeps diagnostic audio worth hearing. **The gate is now `run.outputAudioPath !== undefined`**;
status governs only the failure notice and the stage cells. Absent, not disabled, plus
`[data-run-no-audio]` ("no output audio stored") so the card says why.

### Audio can never reach a ledger line — three independent barriers

The bytes travel a different route than `POST /api/runs`; the route hands them straight to
`writeRunAudio` and returns only `{id, path, bytes}`; and the upload helper takes the `RunsClient`,
not the Run object, so there is nowhere to attach bytes. Pinned by a 1 MB structural test: one
ledger line under 4096 chars with no base64 fragment, full bytes on disk.

- Mutation-checked:
  | mutation | result |
  |---|---|
  | play gated on `status === 'complete'` again | 2 red |
  | an upload failure fails the Run | 1 red |
  | an empty `audioBase64` accepted (zero-byte .wav answering 200-with-silence) | 1 red |
- Corrected the false header in `routes/runs.ts` — *"the orchestrator writes it, so this router only
  reads it"* — which is the comment that made the missing write path look intentional.
