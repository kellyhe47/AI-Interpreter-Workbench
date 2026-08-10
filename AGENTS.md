# AGENTS.md — standing context for coding agents in this repo

## Sources of truth, in order
1. `PRD.md` — the functional contract. Where the design mock and PRD disagree, PRD wins.
2. `design_handoff_interpreter_workbench/` — visual/UX spec (tokens + dc.html copy/styles).
   The mock's "Mock state" chips and its "show recorded runs (mock)" switch are review-only
   simulators and are explicitly NOT built; real state comes from the machine and the ledger.
3. `.tdd/tickets/` — acceptance criteria per unit of work; `.qa/report.md` — QA findings.

## The rules that protect the experiment

These exist because a violation would produce a number that looks fine and is wrong.

- **Arm membership is DERIVED, never declared.** `deriveArmTag(config)` in `src/core/arms.ts` is
  the only way a run gets a tag. There is no arm-labelling control anywhere and there must never
  be one — mislabelling is structurally impossible, not merely discouraged. `ARMS` and `MENUS` are
  deep-frozen. Read `run.armTag`? No: derive it (`runArmTag(run)`).
- **Aggregation gate: named `armTag` AND `origin === 'sweep'` AND `status === 'complete'`**, with
  the realness rule on top. One place decides — `isAggregatableRun` in `src/client/state/ledger.ts`.
  Everything downstream delegates; nothing reimplements it. All three conditions are independently
  load-bearing (verified by mutation).
- **Excluded runs stay VISIBLE.** Manual, ad-hoc and failed runs are real information and appear in
  the per-Recording view — they are simply not evidence. Never filter them out of the store; gate
  them at the aggregate. A grouping that drops them renders `n: 0` and null percentiles, never a
  zero (a zero reads as a measurement).
- **No fixture or placeholder number may ever be presented as a result.** `isRealRecord` /
  `isRealRun` enforce it; don't weaken them. Placeholder recording ids start with `placeholder`.
- **Provenance reports ACTUAL N, never intended N.** `4 of 5 reps completed` — and the p50 beside
  it is computed over those 4. A line that claims 5 while aggregating 4 is the failure mode this
  project exists to prevent. **The denominator comes from `annotations.repIndex` over *attempted*
  sweep runs of any status**, which is why the runner must stamp it (`createRunOnceExecutor`). With
  no `repIndex` the denominator silently falls back to the numerator and every line reads a clean
  `N of N` — it looks right, and it is the bug that hid until a real sweep would have run.
- **A derivation holding the right answer is not the same as a screen showing it.** Three separate
  defects were model-correct and view-wrong: `failedCount` computed and never rendered, the cost
  cell showing `$0.000` over zero samples, the provenance stamp gated on ledger contents while the
  panel showed a load failure. When you add a field to a row model, render it or explain why not.
- **Zero is a measurement; absence is `—`.** Never print `0`, `$0.000` or `0 ms` for a cell with no
  samples. Gate on `n === 0`, not on why `n` is 0.
- **Excluded and failed are independent facts.** A group can be both `in experiments` and partially
  failed; a row must show both rather than choose. Failed runs are absorbed into their
  `(recording × configuration)` group by design — they do not get their own row.
- **Replay is paced at 1× in 20 ms framing.** `src/client/replay/pacer.ts`, wall-clock anchored to
  `t0 + n*FRAME_MS`, never cumulative. Dumping the buffer invalidates VAD, endpointing and every
  latency figure — **and looks like it worked**. Any replay path must go through the pacer.
- **`reps` means RETAINED reps.** The batch runner executes `reps + 1` per cell: one warmup at
  `repIndex 0` stamped `origin: 'manual'` (so it cannot pass the gate by construction), then `reps`
  counted runs. PRD §8's 60-samples-per-arm arithmetic depends on this.
- **Counterbalanced order and warmup discard are what make `origin: 'sweep'` mean anything.** If the
  runner skips them, the label is a lie.
- **Replay context is pinned to zero, both architectures.** It is a control, not a choice — the
  runner takes no context-policy argument and the panel renders it as a locked field.
- **`speechEndMs` comes from the Recording**, so `t0` is identical across every Run of it. A
  transport-supplied `speech_end` mark is discarded.
- **Live records the `contextPolicy` in force at stop**; cascade records `'n/a'` positively, never
  `'default'` — cascade is context-free by design, and `'default'` would imply a knob it lacks and
  file it into the Realtime-default column.
- **`quality.wer` is always null in a `LiveSession`.** Free conversation has no reference transcript;
  WER comes from Replay over the scripted corpus.
- **Nothing autoplays in Replay.** No `AudioContext` is constructed at render; audio is fetched and
  played only from a click. Live is the opposite: autoplay is on, unconditionally.
- **Blind compare is playback-only.** Neither the configuration identity nor the transcript may be
  in the DOM before submit — a TTS reading Cantonese text aloud in Mandarin yields a correct-looking
  transcript and wrong audio, and a text-visible evaluation scores it a success. The drawn order is
  persisted with both dimensions, both run ids and the evaluator language.
- **Named arms are frozen.** Arm A = realtime `gpt-realtime`; B = `gpt-4o-transcribe` →
  `gpt-4o-mini` → `gpt-4o-mini-tts`; C = B with `eleven_flash_v2_5`. `gpt-realtime-mini` is the
  **development** model — a run on it correctly derives `ad-hoc`. Measured paths must pass
  `REALTIME_MODEL` explicitly or Arm A never reaches the ledger.

## Provider and protocol rules

- **No real API calls in vitest or the dev loop.** All tests run on fixtures. Real calls live only
  in `scripts/smoke-*.mjs` (manual) and cost money — budget before running.
- **24 kHz PCM16 mono everywhere.** OpenAI transcription rejects 16 kHz (`rate >= 24000`, verified
  live). Don't reintroduce 16 kHz.
- **GA Realtime event names** (`response.output_audio.delta`, `input_audio_buffer.speech_stopped`,
  `conversation.item.input_audio_transcription.*`; session config under
  `session.audio.input.turn_detection`). The PRD's older beta names in §7 prose are superseded.
- **`SttEvent.type === 'final'` means TURN-final**, never segment-final. For ElevenLabs Scribe the
  turn-final signal is the **committed** transcript; partials are not. Scribe sends the full running
  transcript per message — pass it through, do not accumulate (OpenAI's deltas do accumulate).
- **VAD pinned at `ENDPOINTING_MS` (1000 ms) in every arm**, one constant in `src/core/protocol.ts`
  imported by every wire site and the replay segmenter. A measurement control, not a knob: changing
  it invalidates every take recorded under the old value, so `src/core/protocol.test.ts` holds the
  only literal and fails first. Raised 500 -> 1000 on 2026-08-10 (operator: natural pace did not
  separate utterances); `corpus/SCRIPTS.md` now asks for ~2 s pauses.
- **Every new adapter must pass `src/core/contracts` UNCHANGED.** Register via
  `describeXxxContract(name, factory)` with a mocked transport and extend the provider list only —
  touching an assertion defeats the purpose. That file is byte-identical across v1 and v2 while
  carrying three vendors; keep it that way.
- Adapters take an injectable transport seam (`deps.wsFactory` / `deps.fetchImpl`); keys resolve at
  construction from config or env. A same-vendor model swap is **config-only** — it needs no new
  registry entry.
- **MT `temperature: 0` and a fixed system prompt**, semantically equivalent across MT providers, or
  the experiment measures prompts instead of models.
- Error semantics: 429 → `RateLimitError` (so `withRetry` engages); timeouts via `withTimeout` →
  `TimeoutError`; abort = generator returns cleanly, no leaked timers or sockets. Cascade failure
  copy names the stage; Realtime failure copy is opaque — both are graded product copy.
- **The measured atom is the UTTERANCE, not the Run.** PRD §8: *"one record per utterance per
  arm"*. A corpus Recording is a ≤45 s take holding ~4 utterances with *deliberately different*
  categories (§9, §17 22a), so a Run is the CONTAINER that produced a set of utterance records —
  it is not itself a measurement. Any aggregate computed per-Run is wrong by construction under a
  multi-utterance corpus. See `.tdd/tickets/README-v3-corpus.md`.
- **A Recording carries a manifest of utterances, never a single category.** `src/core/corpus.ts`
  is the canonical home of `CORPUS_CATEGORIES` and `validateManifest`. `src/harness/corpus.ts` is
  the pre-22a *synthetic placeholder* corpus for bench/soak only — never the real corpus shape.
- **The manifest is mapped to measured utterances by ORDER**, so a VAD that segments a clip
  differently than the manifest describes mis-attributes every later utterance in that run: right
  latency, wrong category, wrong reference. A count mismatch must fail the run with a named reason,
  never partially attribute.
- **Recordings VALIDATE their body; runs do not.** `POST /api/recordings` rejects a malformed
  manifest with a 400 and a named reason, because a bad manifest never fails loudly later — it
  silently corrupts every category and WER figure derived from it. `createRecording` whitelists
  fields explicitly, so a new Recording field needs an explicit line there (unlike `appendRun`,
  which stringifies the whole object).
- **Storage is append-only.** `ledger.jsonl` is written with the `a` flag, one JSON object per line,
  never read-modify-write: a crash mid-write must cost one line, not the benchmark history.
  `readLedger` is tolerant and skips an unparseable line.
- **A Run is stored TWICE, deliberately** — one queryable `data/runs/<id>.json` (what `listRuns` and
  `GET /api/runs` serve) plus one line in the append-only `ledger.jsonl` (the history). The
  separation is documented at `storage/index.ts:34`. Editing one and not the other leaves the store
  inconsistent, and a restarted server will still serve what you thought you removed.
- **`POST /api/recordings` assigns its own id** and ignores one supplied in the body. Read the id
  back from the response; seeding runs against an id you chose yourself silently orphans them.
- **Storage and the run route pass unknown keys straight through** — `appendRun` stringifies the
  whole object and the route casts `req.body`. So a new persisted field needs no runtime change and
  will appear to work while being untyped everywhere. Force it with a **compile-level** test that
  annotates a `Run` literal directly; a runtime assertion alone proves nothing here.
- **Recording audio is immutable; deletion is soft; corpus Recordings are undeletable** — the
  operation is *disallowed* (no affordance, 409 from the API), not warned about. A Run must always
  be able to reach the input that produced it.

## Conventions

- Vitest, colocated `*.test.ts(x)`; jsdom only under `src/client/**`. Full suite: `npx vitest run`.
  Typecheck **both** `tsconfig.json` and `tsconfig.server.json`. `src/core/**` is compiled by both,
  so it must stay free of node-only and DOM-only globals. `src/client/**` cannot import
  `src/server/**` (excluded) — mirror entity types instead.
- Design tokens: `src/client/styles/tokens.css` CSS vars only — no hex, `rgb()` or `oklch()`
  literals. Several view tests enforce this by grepping their own source; add the same guard to new
  views. Copy strings from the mock are exact and tests pin them.
- **Assert via `data-*` attributes and text, never CSS classes** — that discipline is why these
  tests survive restyling.
- `src/client/deletions.test.ts` scans `src/client/**` (comments stripped) for retired identifiers.
  Deleted code has no test of its own; that guard is what keeps it deleted.
- Browser fixture mode: `?fixture=1` / `?fixture=fail-mt` scripts the **Live** session only —
  Replay uses the real server there deliberately, since fixture mode exists because a QA browser has
  no grantable microphone and Replay needs none. Fixture mode must keep producing fixture-named
  providers so the ledger excludes its records.
- `data/` is gitignored working state; `results/` is committed and is what the write-up cites.
  `npm run export-results` writes the dated bundle. Note `.gitignore` needs `node_modules` **without**
  a trailing slash — a bare `node_modules/` rule does not match a symlink, and worktree symlinks
  have been committed by accident before.
- `.env` holds `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`. **`src/server/env.ts`
  loads it at the process entrypoint** (ticket 037) — there is no `dotenv` dependency and no
  `--env-file` flag. A real environment variable always WINS over the file, a missing file is not
  an error, and loading is skipped under `NODE_ENV=test` so the suite stays hermetic. Before 037
  nothing loaded `.env` at all, so every real provider call failed and Live was dead on arrival
  under a fully green suite.
- **A green suite says nothing about real credentials or real transports.** Every test runs on
  fixtures by policy, so the entire real-provider path is unexercised by construction. Two defects
  have now lived entirely in that gap (ticket 021's port, ticket 037's env). Probe the real runtime
  — start the server clean and curl the endpoint — before believing a provider path works.
- Commit in logical units with meaningful messages; never push without being asked.
- **Do not run `prettier` on this repo** — there is no prettier config or dependency, so it
  reformats unrelated regions and buries the real diff.
- **Realtime audio is a MEDIA-track path in both directions.** Inbound arrives on the track
  (`ontrack` -> `remoteAudioSink`, ticket 040) and outbound must ride a track too
  (`OutboundAudioSink`, ticket 043) — `response.output_audio.delta` does NOT exist over WebRTC.
  Live feeds that track from the mic; Replay feeds it from the pacer, and the sink belongs to
  Replay's transport factory ONLY — adding one to Live doubles the microphone onto the wire.
- **A lock commit stages ONLY the ticket's declared `test_files`** — never `git add -A`. A
  test-writer that runs a reference implementation first (a practice worth keeping: it has caught
  three real design problems) leaves source in the tree at exactly the moment the orchestrator
  commits the "failing tests".
- **Never mutate a constant the tests import** — the expectation moves with it and nothing fails.
  Mutate the behaviour instead (don't arm the timer at all).
- **A mutation you did not verify landed is worse than no mutation check** — it prints a
  green-looking line and buys false confidence. Confirm each sabotage produces a non-empty
  `git diff` in EXECUTABLE code (matching a comment does not count) before believing its result.
- **Commit BEFORE running a mutation check, and confirm every file it touches is tracked.** The
  revert that undoes a sabotage also undoes uncommitted work, and an UNTRACKED file cannot be
  reverted at all — which silently contaminates the rest of the batch while appearing to succeed.
  This has now cost work twice (tickets 016 and 030).

## Known open items (need the operator)

- **Real corpus recording** — 9 Recordings / 36 utterances (EN + ES read verbatim, YUE improvised).
  Everything downstream is blocked on this: sweeps, WER, blind scoring, every reported number.
  **Land ticket 028's deferred scope WITH this work, not after it.** `utteranceId`, `category`,
  `corpusVersion` and `wer` still have no write path, so the "By utterance category" table renders
  zero rows and every provenance line ends `corpus version unrecorded` no matter how many real
  sweeps run. `repIndex` is already plumbed and is the template; 028's notes specify the rest.
  Recording the corpus without this yields a corpus whose designed analysis cannot execute.
- **Clear `data/` before recording the real corpus.** It holds QA seed Recordings and Runs,
  including deliberately failed and ad-hoc ones, plus blind comparisons. Gitignored working state —
  but a seeded figure sitting next to a real one is exactly the confusion this project forbids.
- **ElevenLabs key scope** — currently TTS-only. Scribe STT needs `speech_to_text` (it will 401
  until then) and billing verification needs `user_read`. No ElevenLabs cost figure may be reported
  until aggregate-vs-per-chunk billing is verified.
- **Live smoke of the two new adapters** — ElevenLabs Scribe and Anthropic MT ship with their wire
  formats *assumed*; each adapter's header documents exactly what was assumed and both accept two
  plausible encodings. One real call each confirms or corrects them.
- **Batch sweeps, WER, blind scoring** — built and unexercised; they need the corpus.
- **Comparison write-up** and **EC2 + Caddy deploy** (AWS credentials absent).
