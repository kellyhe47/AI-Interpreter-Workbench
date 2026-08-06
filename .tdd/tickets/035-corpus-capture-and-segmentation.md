---
id: 035
title: Corpus capture core — record to 24 kHz WAV, and segment a take into utterances
status: pending
source: v3-corpus
depends_on: [030]
touches: [src/client/replay/capture.ts, src/client/replay/segment.ts]
iterations: 0
test_files: []
branch: ""
---

## Why

PRD §7 Replay step 1: *"Record a clip — **maximum 1 minute**. It is saved and appears in the UI."*
This was never built. Ticket 013 scoped it to a caption (*"the record-new-clip affordance states
the 1 minute cap"*) and `ReplayView.tsx:189` states it plainly:
`RECORD_NEW_HINT = 'Microphone capture is not wired into Replay yet'`. **The app cannot ingest its
own primary input.** No ticket ever owned it and no QA flow ever walked it.

## Scope — the CORE only; the UI is ticket 036

Two pure-ish modules, both unit-testable without a real browser.

### 1. `src/client/replay/capture.ts` — record a take to a WAV

**Reuse `src/client/audio/capture.ts` — do not write a second capture path.** It already does
`getUserMedia` behind injectable seams, resamples to 24 kHz, converts with `floatTo16`, and emits
480-sample `Int16Array` frames. This ticket accumulates those frames instead of streaming them.

```ts
export const MAX_TAKE_MS = 60_000;   // PRD §7 hard cap
export const CORPUS_TAKE_MS = 45_000; // PRD §9 guidance for a corpus take

export interface TakeRecorder {
  stop(): Promise<RecordedTake>;   // idempotent
  cancel(): void;
}
export interface RecordedTake {
  samples: Int16Array;   // 24 kHz mono PCM16
  wav: Uint8Array;       // writeWav(samples, 24_000)
  durationMs: number;
}
export function startTake(opts: StartTakeOptions): Promise<TakeRecorder | CaptureDenied>;
```

- Encodes via `writeWav` from `src/harness/wav.ts` at **24 kHz** (AGENTS.md: never 16 kHz).
- **Stops itself at `MAX_TAKE_MS`** — the cap is enforced, not merely captioned.
- Denial propagates the existing four-value permission model unchanged; a denied take starts
  nothing (no context, no pipeline), exactly as `audio/capture.ts` already guarantees.
- `stop()` is idempotent and releases the mic (tracks stopped, pipeline torn down, context closed).

### 2. `src/client/replay/segment.ts` — split a take into utterances

A **pure function over PCM**, no DOM, no node globals, deterministic:

```ts
export interface SegmentOptions {
  silenceMs?: number;      // default 500 — matches the pinned VAD control
  floor?: number;          // RMS threshold for "silence"
  minUtteranceMs?: number; // reject slivers
}
export interface SegmentedUtterance {
  index: number;           // 1-based
  startMs: number;
  trueSpeechEndMs: number; // ms from the START OF THE CLIP — ticket 030's field
}
export function segmentTake(samples: Int16Array, opts?: SegmentOptions): SegmentedUtterance[];
```

`trueSpeechEndMs` is the **last sample above the floor** in that utterance — the true speech end
PRD §8 requires, computed once from the waveform, not a VAD guess.

## Acceptance criteria

- [ ] `startTake` yields 24 kHz mono PCM16 and a WAV whose header round-trips through `readWav`
      at rate 24000
- [ ] The `MAX_TAKE_MS` cap stops the take by itself, verified with an injected clock — not a caption
- [ ] Permission denial returns the existing denied shape and starts no context or pipeline
- [ ] `stop()` is idempotent and releases every track
- [ ] `segmentTake` finds N utterances in a synthetic waveform of N bursts separated by silence,
      with `trueSpeechEndMs` at each burst's last loud sample (±1 frame)
- [ ] A silence gap **shorter** than `silenceMs` does NOT split — a mid-sentence pause is not an
      utterance boundary
- [ ] Leading and trailing silence produce no phantom utterance
- [ ] A take of pure silence returns `[]` rather than one empty utterance
- [ ] Output always satisfies ticket 030's `validateManifest` shape rules: indices 1..N contiguous,
      `trueSpeechEndMs` strictly increasing and within the clip. **Assert this by calling
      `validateManifest` on a manifest built from the segmenter's output** — the two must not drift.
- [ ] `segment.ts` has no DOM or node-only globals

## Explicitly NOT in this ticket

The UI, tagging, and the POST — all **036**. This ticket ships no user-visible change.

## Notes

- Keep the segmenter's defaults aligned with the pinned 500 ms endpointing control, and say so in
  a comment — a segmenter that disagrees with the measured VAD invites boundary disputes later.
- No real API calls; tests run on synthetic waveforms via `generateClip`/hand-built `Int16Array`s.
