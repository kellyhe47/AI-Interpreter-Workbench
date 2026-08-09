# AI Interpreter Workbench

Two live-interpretation architectures — **OpenAI Realtime voice-to-voice (Arm A)** and a
**composable STT → MT → TTS cascade (Arm B)** — running in one browser SPA on shared
microphone audio, instrumented per stage, with an in-app results view fed by an append-only
run ledger. The functional contract is [PRD.md](PRD.md); the visual spec is
[design_handoff_interpreter_workbench/](design_handoff_interpreter_workbench/README.md).

## Setup

```bash
npm install
cp .env.example .env   # then fill in keys (or create .env with the vars below)
```

`.env` (repo root, gitignored):

```
OPENAI_API_KEY=sk-...        # required for both arms
ELEVENLABS_API_KEY=...       # optional; second real TTS provider (not part of any arm)
```

## Run

```bash
npm run dev
```

Server on :8787, Vite client on :5173 (proxied `/api` + `/ws`). Open http://localhost:5173.

- **Fixture mode (no mic, no keys, no spend):** http://localhost:5173/?fixture=1 — scripted
  utterances drive the full UI through the real transports seam. `?fixture=fail-mt` injects
  one mt-stage failure. Fixture records never reach the Results view (realness rule).
- **Production build:** `npm run build && npm start` (single origin: server serves the SPA).
- **Tests:** `npm test` — 461 tests, all fixture-driven, zero network.
- **Manual smoke (real APIs, ~$0.01):** `npm run smoke:openai` · `npm run smoke:elevenlabs`
- **Corpus:** the recorded takes are captured through the in-app Record flow and stored under
  `data/recordings/`; the scripts they are read from are `corpus/SCRIPTS.md` and
  `corpus/LIVE-SCRIPT.md`. (The synthetic tone-burst corpus and the fixture bench/soak scripts
  that consumed it were deleted — they were never an input, and a placeholder number reaching a
  reported figure is exactly what the realness rule exists to prevent.)

## Architecture

```
src/core        shared contracts — provider interfaces (SttProvider / MtProvider / TtsProvider,
                async generators, AbortSignal everywhere; TTS takes AsyncIterable<string>),
                canonical timing vocabulary + UtteranceRecord, cascade wire protocol
                (binary PCM16 24 kHz both directions), fixtures, registry,
                withTiming/withRetry/withTimeout decorators, shared contract test suites
src/server      Express + ws — cascade orchestrator (turn-final trigger, streaming MT→TTS
                bridge, stage-attributed failures), /ws/cascade transport, ephemeral Realtime
                token endpoint (/api/realtime-token), real adapters: OpenAI STT (transcription
                WS, gpt-4o-transcribe), OpenAI MT (gpt-4o-mini stream), OpenAI TTS
                (gpt-4o-mini-tts), ElevenLabs Flash v2.5 TTS (WS stream-input — true
                streaming text input)
src/client      React SPA — session state machine (PRD §6 lifecycle incl. four-value mic
                permission), audio capture/playback (24 kHz PCM16), InterpreterTransport
                implementations (Realtime WebRTC, Cascade WS, fixtures) behind a fan-out
                ArmRouter, session cockpit + results views, append-only RunLedger
src/harness     WAV utils, placeholder corpus builder, fixture bench runner
scripts         smoke tests, corpus generator, bench + soak runners
```

Key invariants:

- **The UI cannot tell arms apart** — it sees `InterpreterTransport`s from the ArmRouter,
  which fans one mic feed out to every active arm.
- **Swapping a provider is a contained change** — one adapter file + one registry line; the
  shared contract suite in `src/core/contracts` is the proof (OpenAI TTS, ElevenLabs TTS,
  and the fixture all pass it unchanged).
- **"final" means turn-final** everywhere (translate once per turn, no interim translation).
- **No fixture/placeholder number is ever reported** — the ledger's realness rule keeps the
  Results view on its empty state until real runs exist.
- Sample rate is **24 kHz end-to-end** (OpenAI transcription sessions reject 16 kHz).

## Status / what's left

Corpus recording (real EN/ES/YUE clips), Deepgram Arm C decision, benchmark sweeps, blind
scoring, and the comparison write-up require real humans/audio and are pending — see
[RUN_LOG.md](RUN_LOG.md) for the full build log and open items. Deployment (EC2 + Caddy per
PRD §13) is deferred until AWS credentials are available; local prod-mode serving is verified.
