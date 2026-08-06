---
id: 035
title: Record a corpus take in-app, segment it, and tag its utterances
status: pending
source: v3-corpus
depends_on: [030]
touches: [src/client/views/ReplayView.tsx, src/client/components/replay/, src/client/replay/segment.ts, src/harness/wav.ts]
iterations: 0
test_files: []
branch: ""
---

## Why

There is currently **no path for a real corpus to enter the store.** The only capture affordance is
"Record new clip · max 1 min", which writes an `origin: 'mic'` Recording with no category, no
reference text and a single `speechEndMs`. The operator has confirmed the corpus is recorded
in-app (PRD §9: English and Cantonese self-recorded, Spanish read by a coworker, ≤45 s per take).

## Scope

A corpus-recording flow, distinct from the ad-hoc mic clip:

1. **Record a take** — ≤45 s, 24 kHz mono PCM16 (§9 format; no resampling in the measured path).
2. **Auto-segment into utterances** by silence, producing candidate boundaries and a
   `trueSpeechEndMs` per utterance computed from the waveform.
3. **Operator confirms and tags** each utterance: category (one of six) and, for EN/ES, the
   verbatim reference text. Cantonese takes no reference (§9 — improvised, no written script).
4. **Save** as `origin: 'corpus'` with the ticket-030 manifest and a `corpusVersion`.

## Acceptance criteria

- [ ] The flow produces a Recording with `origin: 'corpus'`, a valid ticket-030 manifest, and a
      `corpusVersion`
- [ ] Segmentation is **operator-confirmable, never silently authoritative** — the count and
      boundaries are shown and adjustable before save. A wrong boundary here mis-attributes every
      later category finding (see the load-bearing risk in the README), so it must not be a
      black box.
- [ ] `trueSpeechEndMs` per utterance is computed from the waveform ONCE at record time and frozen
      into the manifest — never recomputed per run
- [ ] The segmenter is a pure function over PCM in `src/client/replay/segment.ts`, unit-tested on
      synthetic waveforms, with no DOM or node-only globals if it is shared
- [ ] Reference text is required for EN/ES utterances and refused for YUE — the UI states why
- [ ] A take longer than 45 s is refused with the reason (§9 packaging), and 1 min stays the hard cap
- [ ] The existing ad-hoc "Record new clip" path is unchanged and still produces `origin: 'mic'`
- [ ] Corpus Recordings remain undeletable once saved (§17 25c)
- [ ] Audio is immutable after save; only the label is editable (§7). **Tags are part of the
      manifest, not the label** — decide and document whether re-tagging a saved corpus Recording
      is allowed, given that changing a category retroactively changes what past runs measured.

## Notes

- The last bullet is a real measurement question, not a UI detail. Retagging after runs exist
  silently rewrites the meaning of existing samples. Recommend: allow retagging only while the
  Recording has zero Runs, and disallow it after — same spirit as immutable audio.
- Getting 24 kHz out of the browser: `MediaRecorder` will not give PCM16 directly. Capture via
  an `AudioWorklet`/`ScriptProcessor` at the context rate and downsample once, or force the
  context to 24 kHz. AGENTS.md: OpenAI transcription rejects 16 kHz — do not reintroduce it.
