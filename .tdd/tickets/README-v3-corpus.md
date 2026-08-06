# v3 — the corpus measurement path (tickets 030–034)

## The finding that created this ticket set

Ticket 028 deferred four annotation fields (`utteranceId`, `category`, `corpusVersion`, `wer`) and
called the remaining work "plumbing". **That framing was wrong, and the error is mine.** Wiring
those fields is not possible without an architectural change, for a reason 028's notes missed.

### What the PRD specifies

- **§9:** 9 Recordings holding 36 utterances — *"3 Recordings per direction, ~4 utterances each"*.
  *"Categories are distributed across the recordings, not grouped"*, and *"Every utterance carries
  a category tag — the tag, not the recording, is the meaningful analytical grouping"*.
- **§8, "The utterance record — single source of truth":** *"One record per utterance per arm,
  persisted and exported."* The ledger is *"a single append-only run ledger **of utterance
  records** … grouped by run and experiment"*.
- **§8 results:** *"By Recording — three rows per recording, one per configuration, each
  aggregating that recording's **20 samples (4 utterances × 5 reps)**"*, and 60 samples per arm
  (12 utterances × 5 repetitions).
- **§17 22a** (the decision log, which settles it): *"Corpus repackaged: 3 Recordings × ~4
  utterances per direction — Recordings and utterances are decoupled under Replay. Same content and
  statistical N, **a quarter of the runs**."*

### What was actually built

The Replay measurement path treats **one Recording as one utterance**:

- `Recording` carries a single `speechEndMs`.
- `runOnce` (`src/client/replay/runner.ts:144`) keeps one flat `timings` map — `onTiming` overwrites
  by event name, so later utterances clobber earlier ones — and `onUtteranceComplete` calls
  `finish()`, so the run is considered over at the first utterance boundary.
- A `Run` holds one `timings`, one `transcripts`, one `cost`. One Run = one latency sample.

### The consequences

1. **N is 4× too small.** A sweep yields 15 samples per arm per direction, not the 60 §8 reports.
   §17 22a's "same statistical N, a quarter of the runs" is only true if a run produces four
   records; it produces one.
2. **The by-category table cannot ever fill** — and *not* merely because nothing writes the field,
   which is what 028 concluded. A Run spans ~4 utterances of *deliberately different* categories,
   so there is no single category to write. 028's proposed fix (put a `category` on the Recording)
   is incoherent against §9's distribution rule.
3. **WER has nothing to attach to** — the reference is per utterance.
4. Everything after the first utterance boundary in a corpus Recording is currently measured
   incoherently: `timings` ends up holding a mix of marks across utterances.

Both transports already emit `utterance.complete` per utterance
(`src/client/transport/cascade.ts:214`, `router.ts:110`), and §17 21c confirms the design intent —
*"A 1-minute clip holds several utterances"*. **The segmentation exists; `runOnce` discards it.**

## The tickets

| id | title | why it is separable |
|---|---|---|
| 030 | Recording carries a corpus utterance manifest | pure data model + persistence; nothing reads it yet |
| 031 | Per-utterance measurement in `runOnce` | produces N utterance records per Run |
| 032 | Aggregate over utterance records | the gate, groupBy*, provenance, experiments |
| 033 | `corpusVersion` stamped by the runner | the last of 028's fields; trivial once 030 lands |
| 034 | WER write path | post-hoc scoring against `referenceText` |
| 035 | Corpus capture + segmentation core | pure modules; no user-visible change |
| 036 | Wire "Record new clip" — record, tag, save | the flow PRD §7 step 1 always required |

030 makes "my corpus is saved" true. 031 + 032 make "its analysis can run against it" true. 033
completes provenance. 034 adds the one metric that needs a second pass.

## The load-bearing risk, stated once so it is not rediscovered late

**The manifest is mapped to measured utterances by ORDER** — the Nth `utterance.complete` is
manifest entry N. If a provider's VAD splits a clip differently than the manifest describes (an
extra split on a long pause, or two short utterances merged), every subsequent utterance in that
run is mis-attributed: right latency, wrong category, wrong reference text. That produces
*plausible, wrong* category findings — the exact failure class this project exists to prevent.

Ticket 031 must therefore treat a count mismatch as a **run-level failure with a named reason**,
never as a best-effort partial attribution. A run whose segmentation disagrees with the manifest is
not evidence.

## Standing rule this establishes

**The measured atom is the utterance, not the Run.** A Run is the container that produced a set of
utterance records; it is not itself a measurement. Any aggregate computed per-Run rather than
per-utterance-record is wrong by construction under a multi-utterance corpus.

## Decisions confirmed by the operator (2026-08-06)

1. **Packaging: 3 Recordings per direction, ~4 utterances each (9 total).** Confirmed against
   §17 22a and §9. The 36-single-utterance-clip model in `src/harness/corpus.ts` (ticket 015) is
   **pre-22a and superseded** for the real corpus — it stays only as the synthetic placeholder for
   bench/soak, which is what it is marked as. Tickets 031 and 032 (the architectural ones) are
   therefore in scope, not optional.
2. **Ingestion: recorded in-app via the microphone.** The operator records each ≤45 s take in the
   browser (English and Cantonese self-recorded, Spanish read by a coworker, per §9), then tags its
   utterances. This adds **ticket 035**, without which there is no way for a real corpus to enter
   the store at all — today the only path is the mic recorder, which produces an `origin: 'mic'`
   Recording carrying no metadata.

### What this means for `speechEndMs`

§8 requires t0 to be *"corpus-derived true speech end"*, computed offline, never a VAD guess that
differs per arm. Recording in-app does not weaken that: the boundary is computed **once**, from the
captured waveform, at record time — and then frozen into the manifest. Every Run of that Recording
then shares it. What §8 forbids is deriving it per-run inside the measured path, and that stays
forbidden.


## The ingestion gap (found 2026-08-06, after the tickets above were written)

PRD §7 Replay step 1 — *"Record a clip — maximum 1 minute. It is saved and appears in the UI"* —
**was never built.** Ticket 013 scoped it to a caption (its only AC was that the affordance "states
the 1 minute cap") and deferred the recorder to "the Live view's recorder"; no ticket ever picked it
up. `ReplayView.tsx:189` says so in the source: `'Microphone capture is not wired into Replay yet'`.

Six QA iterations missed it because no flow ever walked "record a clip" — the manual-qa rule
*"a requirement no flow touches is a finding"* was not applied to §7's first step. **Any future QA
pass must walk ingestion, not only what happens to data already in the store.**

Tickets 035 and 036 close it. Good news on scope: `src/client/audio/capture.ts` (ticket 010) already
does getUserMedia behind injectable seams, resamples to 24 kHz and emits 480-sample PCM16 frames, so
035 accumulates those rather than writing a second capture path.
