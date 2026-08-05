# AGENTS.md — standing context for coding agents in this repo

## Sources of truth, in order
1. `PRD.md` — the functional contract. Where the design mock and PRD disagree, PRD wins.
2. `design_handoff_interpreter_workbench/` — visual/UX spec (tokens + dc.html copy/styles).
   The mock's "Mock state" chips and hardcoded "mic allowed" label are explicitly NOT to be
   built; mic permission is a live four-value property (PRD §6).
3. `.tdd/tickets/` — decomposition history with acceptance criteria; `.qa/report.md` — QA
   findings ledger.

## Hard rules
- **No real API calls in vitest or the dev loop.** All tests run on fixtures. Real calls live
  only in `scripts/smoke-*.mjs` (manual) and cost money — budget before running.
- **No fixture/placeholder number may ever be presented as a result.** The ledger's
  `isRealRecord` rule enforces this; don't weaken it. Placeholder corpus ids start with
  `placeholder`.
- **24 kHz PCM16 mono everywhere.** OpenAI transcription sessions reject 16 kHz
  (`rate >= 24000` enforced server-side by OpenAI — verified live). Don't reintroduce 16 kHz.
- **GA Realtime event names** (`response.output_audio.delta`,
  `input_audio_buffer.speech_stopped`, `conversation.item.input_audio_transcription.*`,
  session config under `session.audio.input.turn_detection`). The PRD's older beta names in
  §7 prose are superseded; adapters use GA names.
- **`SttEvent.type === 'final'` means TURN-final** (endpoint after 500 ms silence), never
  segment-final. The contract suite asserts the mapping per adapter.
- **VAD pinned at `silence_duration_ms: 500` in every arm.** It's a measurement control, not
  a tuning knob.
- Every new provider adapter must pass the shared suites in `src/core/contracts` unchanged —
  register via `describeXxxContract(name, factory)` with a mocked transport. Adapters take an
  injectable transport seam (`deps.wsFactory` / `deps.fetchImpl`); keys resolve at
  construction from config or env.
- Error semantics: 429 → `RateLimitError` (so `withRetry` engages); timeouts via
  `withTimeout` → `TimeoutError`; abort = generator returns cleanly, no leaked timers or
  sockets. Cascade failure copy names the stage; Realtime failure copy is the exact opaque
  string in `src/client/transport/realtime.ts` — both are graded product copy, not incidental.
- Switch semantics: mode/language/direction changes apply immediately when no utterance is in
  flight; queue and apply at the utterance boundary when one is (banner while pending).

## Conventions
- Vitest, colocated `*.test.ts(x)`; jsdom only under `src/client/**`. Full suite:
  `npx vitest run`. Typecheck: both `tsconfig.json` and `tsconfig.server.json` (bundler
  resolution — extensionless relative imports; server runs under tsx, no emit).
- Design tokens: `src/client/styles/tokens.css` CSS vars only — no hardcoded colors/sizes.
  Copy strings from the mock are exact; tests pin them.
- Browser-drivable fixture mode: `?fixture=1` / `?fixture=fail-mt` (shared utterance timeline
  across arms). Use it for manual QA and future Playwright work; it must keep producing
  fixture-named providers so the ledger excludes its records.
- `.env` holds `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`. The ElevenLabs key is TTS-scoped only:
  `/v1/user/subscription` and `/v1/history` return 401 — billing verification needs the
  dashboard or a wider-scoped key.
- Commit in logical units with meaningful messages; never push without being asked.

## Known open items (need the operator)
Real corpus recording; Arm C STT vendor decision (no Deepgram adapter exists by design);
benchmark sweeps + WER + blind scoring (need real corpus); comparison write-up; EC2+Caddy
deploy (AWS credentials absent); ElevenLabs aggregate-vs-per-chunk billing verification.
