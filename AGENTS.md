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
  project exists to prevent.
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
- **VAD pinned at `silence_duration_ms: 500` in every arm.** A measurement control, not a knob.
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
- **Storage is append-only.** `ledger.jsonl` is written with the `a` flag, one JSON object per line,
  never read-modify-write: a crash mid-write must cost one line, not the benchmark history.
  `readLedger` is tolerant and skips an unparseable line.
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
- `.env` holds `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`.
- Commit in logical units with meaningful messages; never push without being asked.

## Known open items (need the operator)

- **Real corpus recording** — 9 Recordings / 36 utterances (EN + ES read verbatim, YUE improvised).
  Everything downstream is blocked on this: sweeps, WER, blind scoring, every reported number.
- **ElevenLabs key scope** — currently TTS-only. Scribe STT needs `speech_to_text` (it will 401
  until then) and billing verification needs `user_read`. No ElevenLabs cost figure may be reported
  until aggregate-vs-per-chunk billing is verified.
- **Live smoke of the two new adapters** — ElevenLabs Scribe and Anthropic MT ship with their wire
  formats *assumed*; each adapter's header documents exactly what was assumed and both accept two
  plausible encodings. One real call each confirms or corrects them.
- **Batch sweeps, WER, blind scoring** — built and unexercised; they need the corpus.
- **Comparison write-up** and **EC2 + Caddy deploy** (AWS credentials absent).
