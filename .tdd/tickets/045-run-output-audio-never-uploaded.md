---
id: 045
title: Run output audio is never uploaded — the play button 404s and blind compare has nothing to play
status: pending
source: qa-live
depends_on: []
touches: [src/server/routes/runs.ts, src/client/replay/recordingsClient.ts, src/client/replay/runner.ts, src/client/components/replay/RunsList.tsx]
iterations: 0
test_files: []
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

- [ ] A run that produced output audio uploads it after the Run is POSTed, and
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
