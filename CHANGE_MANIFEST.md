# Change Manifest — v1 build → v2 (Replay flow)

**Read this before touching any file.** It is the authoritative list of what changes and what does not. It exists so the delta is *told* rather than *discovered* — do not survey the codebase to work out what to do.

**Companion documents:**
- `PRD.md` — the functional contract. §7 (Product Flow & Storage) and §8 (Measurement) hold most of what is new.
- `design_handoff_interpreter_workbench/README.md` — v2 visual spec. Start there, then the standalone mock.

**Approach: incremental.** Roughly half the source survives untouched, and it is the half that was expensive to get right — adapters encoding preflight-discovered protocol details, the streaming orchestrator, and the interface/contract/decorator foundation the v2 PRD still specifies unchanged.

---

## Ground rules

1. **Do not open files in KEEP** unless a MODIFY entry explicitly requires it. They are correct and preflight-verified.
2. **Do not re-derive settled decisions.** `PRD.md` §17 records ~120 of them with reasoning, including designs that were tried and reversed. If something looks arbitrary, it is in the log.
3. **The design mock is a prototype**, not production code. Recreate in React/TypeScript using `design_system/tokens/*.css`. Do not copy its markup or logic class.
4. **Tests stay green throughout.** The existing suite passes; a red suite means a mistake, not progress.
5. Commit continuously in logical units. Append to `RUN_LOG.md` as you go.

---

## READ — inputs, never edited

| Path | What it is |
|---|---|
| `design_handoff_interpreter_workbench/README.md` | v2 visual spec. **Start here.** |
| `design_handoff_interpreter_workbench/interpreter-workbench-v2-standalone.html` | Self-contained interactive mock — open in a browser and click through it. |
| `design_handoff_interpreter_workbench/interpreter-workbench-v2.dc.html` | Source of the mock: exact styles, copy, and state transitions. Read for detail; do not copy its markup or logic class. |
| `design_handoff_interpreter_workbench/design_system/tokens/{colors,typography,spacing,effects,fonts}.css` | Token source of truth. Copied into `src/client/styles/tokens.css` (see MODIFY). |
| `PRD.md` | Functional contract. |
| `RUN_LOG.md` | v1 history — read for context on preflight findings; append a v2 section, do not rewrite. |
| `AGENTS.md` | Standing rules for this repo. Update with forward-looking context only — no history, no run narrative. |
| `.tdd/tickets/*`, `.tdd/config.md`, `.qa/report.md` | Artifacts of the v1 run. **Historical — ignore.** `/tdd-orchestrator` will write new tickets; do not reconcile against the old ones. |

---

## KEEP — do not modify

| Path | Why it survives |
|---|---|
| `src/core/types.ts` | The three stage interfaces are unchanged in v2. `TtsProvider.synthesize` taking `AsyncIterable<string>` is load-bearing — see §17, decision 15. |
| `src/core/decorators/index.ts` | `withTiming` / `withRetry` / `withTimeout`. Unchanged. |
| `src/core/fixtures/index.ts` | Fixture providers per stage. Unchanged. |
| `src/core/timing.ts` | Timing vocabulary. Unchanged. |
| `src/server/providers/openai-stt.ts` | Encodes 24 kHz requirement and the turn-final signal discovered in preflight. Already accepts `config.model`. |
| `src/server/providers/openai-mt.ts` | Unchanged. |
| `src/server/providers/openai-tts.ts` | Unchanged. Already accepts `config.model`. |
| `src/server/providers/internal.ts`, `transport.ts`, `test-support.ts` | Shared provider plumbing. |
| `src/server/cascade/orchestrator.ts` | Streaming pipeline, turn-final handling, per-stage timing capture. The v2 model does not change how a cascade utterance is processed. |
| `src/server/token.ts` | Ephemeral token minting. |
| `src/client/audio/capture.ts`, `pcm.ts`, `playback.ts` | Mic capture, PCM conversion, playback. Live still uses all three; Replay reuses playback. |
| `src/client/transport/realtime.ts`, `cascade.ts` | Both transports are unchanged — only what feeds them changes. |
| `src/harness/wav.ts`, `corpus.ts` | WAV encode/decode and corpus loading. Recordings reuse both. |
| `scripts/smoke-openai.mjs`, `smoke-elevenlabs.mjs`, `soak-fixture.mjs`, `generate-placeholder-corpus.mjs` | Still valid. |
| `index.html`, `vite.config.ts`, `vitest.config.ts`, `vitest.setup.ts`, `tsconfig.json`, `tsconfig.server.json`, `.claude/launch.json`, `src/client/main.tsx` | Build and dev config. No change required — listed explicitly so you don't wonder. |

---

## MODIFY

| Path | Change | Reference |
|---|---|---|
| `src/core/registry.ts` | Register the new adapters and model variants: `elevenlabs` (STT), `anthropic` (MT), plus config-only entries for `gpt-4o-mini-transcribe` and ElevenLabs Multilingual v2. Unknown-name error must list all known names, as now. | PRD §6 |
| `src/server/providers/elevenlabs-tts.ts` | **`model_id=eleven_flash_v2_5` is hardcoded in the URL (~line 87).** Parameterize it via config, defaulting to Flash. This alone unlocks Multilingual v2 as a menu option. Every other adapter already parameterizes its model; this one is an outlier. | PRD §6 |
| `src/core/protocol.ts` | Extend `ClientToServerMessage` with `recordingId`, `runId`, and `origin`. Cascade needs no context-policy field — cascade is context-free by design. | PRD §7 |
| `src/server/ws.ts` | Keep the WS cascade path as-is. Add nothing here beyond passing run identity through to the record. | PRD §7 |
| `src/client/transport/router.ts` | **Fan-out → switch.** One active transport at a time. Delete multi-transport routing, the arm collection, and per-arm event multiplexing. | §17, 19b · 24a |
| `src/client/state/sessionMachine.ts` | Rework to the §7 state machine: `idle · requesting-permission · permission-denied · listening · processing · ready · playing · switch-queued · reconnecting · disconnected · stopping · stopped`. `permission-denied` blocks session start. | PRD §7 |
| `src/client/state/ledger.ts` | Becomes the client view over the server-persisted ledger. Add `Recording`, `Run`, `LiveSession`. Aggregation gated on **`armTag` matched AND `origin === 'sweep'` AND `status === 'complete'`**. | PRD §7, §8 |
| `src/client/views/useSessionController.ts` | **Largest single change.** Remove `ARM_CATALOG` multi-arm state, `CASCADE_PROVIDERS` preset map, `ADD_ORDER`, and add/remove-arm actions. Replace with: one active architecture, per-stage model selection, `contextPolicy` (Live only), boundary-queued switching for mode *and* pair *and* direction. | PRD §7 |
| `src/client/views/SessionView.tsx` → **rename `LiveView.tsx`** | Single architecture, autoplay on, ≤5 min with elapsed/limit display, four-value mic permission indicator, banners per the mock. Delete the multi-column arm grid and the arms strip. | design README §Live |
| `src/client/views/ResultsView.tsx` | Two tabs — **Experiments** (4 question-titled cards) and **By Recording & category**. Provenance lines must report **actual N** (`4 of 5 reps completed`), never intended N. Empty state is the default. | PRD §8 |
| `src/client/components/results/derive.ts` | Aggregation predicate updated per the ledger rule above; add `groupBy` for recording and for utterance category. | PRD §8 |
| `src/client/components/session/BlindCompare.tsx` | Move to Replay, launched from a Recording's runs. Pairwise only. **Playback-only — transcripts hidden until submit** (showing text would let wrong-language pronunciation pass). Random draw persisted to the ledger. | PRD §10 |
| `src/client/components/TopBar.tsx` | Four tabs: Live · Replay · Results · Help. Live-session indicator on the right. | design README §Top bar |
| `src/client/App.tsx` | Route the four views. | — |
| `src/client/browserDeps.ts`, `fixtureDeps.ts`, `views/sessionTestKit.ts` | Follow the controller rework. `sessionTestKit.ts:113` still references `stt: 'deepgram'` — a vendor that was cut; remove it. | — |
| `src/server/index.ts` | Mount the new recordings/runs routers alongside `createTokenRouter()`. Static SPA serving is unchanged. | PRD §7 |
| `src/client/styles/tokens.css` | Sync to the v2 design system — `design_handoff_interpreter_workbench/design_system/tokens/*.css` is the source of truth (32 lines currently vs 64 there). Do this **before** building views, or every component gets restyled twice. | design README |
| `src/client/transport/types.ts` | `InterpreterTransport` is unchanged in shape, but drop any arm/multi-transport typing the router relied on. | — |
| `src/client/transport/fixture.ts` | Fixture transport must serve Replay (fed from a Recording) as well as Live. | PRD §7 |
| `src/client/components/results/testRecords.ts` | Test fixtures for the results view; rework to `Recording`/`Run`/`LiveSession` shapes, including a failed run, an ad-hoc run, and a short-rep-count case. | PRD §8 |
| `package.json` | Add the `export-results` script. **No new dependency needed** — adapters use injected `fetch`, not vendor SDKs; follow the pattern in `openai-mt.ts`. | — |
| `.env.example` | Add `ANTHROPIC_API_KEY` (Claude MT). Note the ElevenLabs key needs `speech_to_text` scope for Scribe. | PRD §6 |
| `src/core/contracts/index.ts` | Add the new adapters to the suite's provider list. **Do not touch the assertions** — a new provider passing the suite *unmodified* is what "interchangeable" means. | PRD §13 |
| `.gitignore` | Add `data/`. Working state (recordings, runs, ledger, output audio) is local and disposable; `results/` is committed and is what the write-up cites. Neither is currently listed. | PRD §7 |
| `src/harness/bench.ts` | Keep as the **fixture-only Node bench** used by `scripts/bench-fixture.mjs`. Do **not** try to grow it into the batch runner — it drives the WS cascade path from Node and structurally cannot exercise Realtime's browser→OpenAI WebRTC path. Its 20 ms chunking logic is a useful reference for the client pacer. | PRD §8 |

---

## ADD

| Path | What it is | Reference |
|---|---|---|
| `src/core/arms.ts` | Frozen Arm A/B/C definitions and **`deriveArmTag(config)`**. Membership is computed from the configuration, never declared — there is no arm-labelling UI. Anything not matching a named arm derives `ad-hoc`. | §17, 22d–22e |
| `src/server/providers/elevenlabs-stt.ts` | ElevenLabs Scribe v2 Realtime. WebSocket, partial + **committed** transcripts; **committed is the turn-final signal**, partials are not. Requires the ElevenLabs key scope to include `speech_to_text`. | PRD §6 |
| `src/server/providers/anthropic-mt.ts` | Claude Haiku 4.5, streaming. Key already in `.env`. | PRD §6 |
| `src/server/storage/` | Filesystem store: `recordings/<id>.wav` + `.json`, `runs/<id>.json` + `.out.wav`, append-only `ledger.jsonl`. Soft delete; corpus Recordings undeletable. | PRD §7 |
| `src/server/routes/` | REST: `POST/GET /recordings`, `GET /recordings/:id/audio`, `POST/GET /runs`, `GET /runs/:id/audio`. | PRD §7 |
| `src/client/replay/pacer.ts` | **Feeds a Recording at 1× in 20 ms framing.** Dumping the buffer as fast as the socket accepts would invalidate VAD, endpointing and every latency figure — and would look like it worked. Test-asserted. | PRD §7 · §13 test 7 |
| `src/client/views/ReplayView.tsx` | Two columns: Recordings library (330px) + config/runs. | design README §Replay |
| `src/client/views/HelpView.tsx` | Six plain-language cards. | design README §Help |
| `src/client/components/replay/RecordingsLibrary.tsx` | Rows with label, corpus/mic pill, language, duration, run count. Editable labels, soft delete, corpus undeletable. Record-new capped at 1 min. | PRD §7 |
| `src/client/components/replay/RunConfigPanel.tsx` | Architecture toggle, per-stage model selectors, **live derived-tag pill** ("derived tag: Arm B" / "ad-hoc"), Run and Batch-sweep buttons. Default state is **Arm B's triple**. Replay context is pinned to zero and shown as a locked field. | PRD §6, §7 |
| `src/client/components/replay/RunsList.tsx` | Per-Recording run cards: armTag pill, config string, origin/rep/snapshot meta, complete/failed pill, on-demand playback, labelled per-stage ms, total and $/min. | design README §Replay |
| `src/client/components/replay/BatchProgress.tsx` | Position in matrix, elapsed/remaining, progress bar, **Cancel — keep completed runs**. | PRD §7 |
| `src/client/batch/runner.ts` | Executes recordings × configurations × reps **sequentially**. Applies **counterbalanced ordering** and **warmup discard**, and records `origin: 'sweep'`. A failed run is retried **once**, then recorded `status: 'failed'` and the batch continues. Cancellation retains completed runs. | PRD §7, §8 |
| `scripts/export-results.mjs` | Writes `results/<date>/` — run records plus summary. `data/` is gitignored; `results/` is committed and is what the write-up cites. | PRD §7 |

---

## Tests

**34 test files exist and the suite is green. Keep it green.**

**Rule: every MODIFY implies its co-located test changes.** Tests live beside their source (`foo.ts` / `foo.test.ts`), so the test to update is always obvious — do not go looking.

These need **structural** rework rather than incidental edits:

| Test | Why |
|---|---|
| `views/SessionView.test.tsx`, `views/SessionView.flow.test.tsx` | Rename with the view (`LiveView`), drop multi-arm and fan-out assertions |
| `transport/router.test.ts` | Fan-out → switch |
| `state/sessionMachine.test.ts` | New state set |
| `state/ledger.test.ts` | Recording / Run / LiveSession; aggregation gated on armTag + origin + status |
| `views/ResultsView.test.tsx` | Two tabs, actual-N provenance |
| `components/results/derive.test.ts` | New aggregation predicate and groupings |
| `components/session/BlindCompare.test.tsx` | Pairwise, playback-only, persisted draw |
| `core/registry.test.ts`, `core/registry-adapters.test.ts` | New providers; unknown-name error must list all known names |
| `core/protocol.test.ts` | New message fields |
| `server/index.test.ts`, `server/ws.test.ts` | New routes |
| `core/contracts/contracts.test.ts` | Extend the suite's provider list — **do not modify the assertions.** A new adapter passing the suite *unmodified* is the definition of interchangeable |

**Unaffected** (source is in KEEP): `audio/*`, `core/decorators`, `core/fixtures`, `core/timing`, `harness/wav`, `harness/corpus`, `server/token`, `server/cascade/orchestrator`, `server/providers/openai-*`, `transport/realtime`, `transport/cascade`.

**Every other `*.test.ts` in the repo is unaffected** — if its source file is in KEEP, its test is too. That rule covers the remainder; they are not listed individually.

**Three new tests** are required — see Verification.

---

## DELETE

| What | Where |
|---|---|
| Multi-arm state, `ARM_CATALOG` multi-select, `CASCADE_PROVIDERS` preset map, `ADD_ORDER`, add/remove-arm actions | `useSessionController.ts` |
| Fan-out routing and per-arm event multiplexing | `transport/router.ts` |
| Audible-arm selection, "two arms would talk over each other" state, add-arm affordance, multi-column arm grid | `SessionView.tsx` → `LiveView.tsx` |
| `stt: 'deepgram'` reference | `views/sessionTestKit.ts:113` |

---

## Sequence

Dependency order, not a schedule.

1. `src/core/arms.ts` — everything downstream needs `deriveArmTag`
2. Server storage + REST routes
3. Client pacer + Replay run execution
4. `ReplayView` and its components
5. Live mode rework + router switch
6. New adapters (Scribe, Anthropic) + registry + the ElevenLabs `model_id` fix
7. Per-stage selection UI
8. Batch runner
9. Results rework
10. Help view

**Blocked on the operator, not on you:** real corpus recording, sweeps, blind scoring, ElevenLabs key scope (`speech_to_text` + `user_read`), AWS deploy. Build against the placeholder corpus and leave empty states empty.

---

## Verification

- Full suite green, including three new tests: **replay 1× pacing**, **derived `armTag`**, **sweep controls** (warmup discard + counterbalancing actually applied).
- Every new adapter passes the existing contract suite **unmodified** — that is the definition of interchangeable.
- Typecheck and production build clean; server boots and serves the built SPA from one origin.
- A manual pass: record a clip, run it through two configurations, confirm both appear under that Recording with derived tags, and confirm a manual run never reaches an experiment aggregate.

**Never:** report a number sourced from a fixture run, or aggregate a run whose `origin` is `manual` or whose `status` is `failed`.
