---
id: 002
title: Wire protocol run identity + filesystem storage layer
status: pending
depends_on: []
touches: [src/core/protocol.ts, src/core/protocol.test.ts, src/server/storage/]
iterations: 0
test_files: []
branch: ""
---

## Scope

Two things, both server-side/isomorphic, no UI:

1. **MODIFY `src/core/protocol.ts`** — extend `ClientToServerMessage`'s `session.start`
   variant with `recordingId?`, `runId?`, and `origin?`. Cascade needs **no** context-policy
   field: cascade is context-free by design (PRD §7), and adding one would imply a control
   that does not exist.
2. **ADD `src/server/storage/`** — the filesystem store described in PRD §7 "Storage —
   server filesystem, append-only ledger". Pure data layer: no express, no HTTP. Routes are
   ticket 003 and must be able to sit on top of this without reaching into `fs` themselves.

Do NOT build: REST routes, the client, the batch runner.

## Storage layout (PRD §7 — normative)

```
data/                       gitignored working state (already in .gitignore)
  recordings/<id>.wav       24 kHz mono PCM16
  recordings/<id>.json      label, language, durationMs, speechEndMs, origin, capturedAt, deletedAt
  runs/<id>.json            the Run record
  runs/<id>.out.wav         synthesized output audio
  ledger.jsonl              append-only, ONE LINE PER RUN
```

The root directory is **injected**, not hardcoded — the constructor/factory takes a base
path so tests use a `mkdtemp` temp dir and never write into the repo. Directories are
created on demand.

## Entities (PRD §7)

```ts
Recording { id, label, sourceLanguage, durationMs, speechEndMs,
            origin: 'mic' | 'corpus', createdAt, deletedAt?: number }

Run { id, recordingId, architecture, providerTriple, modelSnapshots,
      armTag: 'A'|'B'|'C'|'ad-hoc', origin: 'sweep'|'manual',
      status: 'complete'|'failed',
      timings, transcripts, outputAudioPath, cost, errors, createdAt }
```

## Acceptance criteria

**Protocol**
- [ ] `session.start` accepts optional `recordingId`, `runId`, `origin` and still
      type-checks without them (Live sends none of the three)
- [ ] `origin` is typed `'sweep' | 'manual'` — the same vocabulary as the Run record, not a
      free string
- [ ] Existing protocol behaviour is untouched: `encodeTtsFrame`/`decodeTtsFrame` round-trip,
      `SAMPLE_RATE === 24000`, the `ServerToClientMessage` union is unchanged

**Recordings**
- [ ] `createRecording(meta, wavBytes)` writes `<id>.wav` + `<id>.json` and returns the
      stored Recording with a generated id
- [ ] `getRecording(id)` / `readRecordingAudio(id)` round-trip the metadata and the exact
      WAV bytes
- [ ] `listRecordings()` omits soft-deleted Recordings by default and includes them under an
      explicit `{ includeDeleted: true }` option
- [ ] `updateRecordingLabel(id, label)` changes ONLY the label — a second read shows the same
      `durationMs`, `speechEndMs`, `origin`, `createdAt`, and identical audio bytes.
      **Audio is immutable**: there is no API to replace a Recording's audio
- [ ] `deleteRecording(id)` on a `mic` Recording is SOFT — it stamps `deletedAt`, the audio
      file and the JSON both still exist, and its Runs are still readable
- [ ] `deleteRecording(id)` on a `corpus` Recording **throws** and changes nothing: corpus
      Recordings cannot be deleted at all (PRD §7, §17 25c). The error message says why
- [ ] A missing/unreadable recording surfaces as a typed "unplayable" result rather than an
      unhandled `ENOENT` throw (PRD §12) — `getRecording` on an unknown id returns
      `undefined`/null, and `readRecordingAudio` on a recording whose WAV is absent throws a
      named storage error the route layer can map

**Runs**
- [ ] `appendRun(run)` writes `runs/<id>.json`, appends exactly ONE line of JSON to
      `ledger.jsonl`, and never rewrites an earlier line (append-only — PRD §17 20b).
      Appending three runs leaves a 3-line ledger, in append order
- [ ] `writeRunAudio(runId, wavBytes)` writes `runs/<runId>.out.wav`; `readRunAudio` returns
      the exact bytes
- [ ] `listRuns()` returns every run; `listRuns({ recordingId })` filters to one Recording
- [ ] A run with `status: 'failed'` is stored and listed like any other — failed runs are
      saved and visible (they are excluded from aggregates by the *reader*, not by storage)
- [ ] `readLedger()` parses `ledger.jsonl` back into run records, tolerating a trailing
      newline and skipping a malformed final line without throwing (a crash mid-write must
      cost one line, not the whole ledger)
- [ ] Two stores pointed at the same base path see each other's writes — state lives on disk,
      not in process memory

## Test plan

New `src/server/storage/*.test.ts` (node env — `src/server/**` is not jsdom). Use
`fs.mkdtemp(os.tmpdir())` for the base path and clean up after. Update
`src/core/protocol.test.ts` for the new fields.

## Attempt log
