---
id: 004
title: ElevenLabs Scribe v2 Realtime STT adapter
status: in-progress
depends_on: []
touches: [src/server/providers/elevenlabs-stt.ts, src/server/providers/elevenlabs-stt.test.ts]
iterations: 0
test_files: []
branch: "tdd/004"
---

## Scope

**ADD `src/server/providers/elevenlabs-stt.ts`** — an `SttProvider` for ElevenLabs
Scribe v2 Realtime. WebSocket transport, injected through `deps.wsFactory` exactly like
`openai-stt.ts`. No new npm dependency; no vendor SDK.

Registry wiring and the shared contract suite registration are ticket 006 — do NOT edit
`src/core/registry.ts` or `src/core/contracts/`. This ticket delivers the adapter and its own
adapter test only.

## Design

Mirror `openai-stt.ts` structurally — it is the exemplar for a WS-based STT adapter and its
shape (AsyncQueue bridging listeners to the generator, abort handling, lazy default ws
factory) is proven. Reuse the helpers in `src/server/providers/internal.ts`
(`AsyncQueue`, `bytesToBase64`, `int16ToLeBytes`, `loadDefaultWsFactory`, `waitForOpen`) and
`transport.ts` (`envVar`, `WsFactory`).

- Class `ElevenLabsStt implements SttProvider`, `readonly name = 'elevenlabs'`.
- `ElevenLabsSttConfig { apiKey?; model?; languageCode? }`; API key resolved AT CONSTRUCTION
  from `config.apiKey ?? envVar('ELEVENLABS_API_KEY')`. Default model `scribe_v2_realtime`.
- Auth header `xi-api-key: <key>` (the same header `elevenlabs-tts.ts` uses).
- Audio input: one frame per `Int16Array` chunk pulled from the input iterable, base64 of
  little-endian PCM16 — same shape as the OpenAI adapter's `input_audio_buffer.append`.
- **24 kHz** is pinned project-wide; the session/config frame declares 24000.
- VAD/endpointing is pinned to `silence_duration_ms: 500` like every other arm (PRD §8).

**The turn-final mapping is the point of this ticket (PRD §6, §8, §13 test 6):**
Scribe emits *partial* transcripts and *committed* transcripts. **`committed` is the
turn-final signal; partials are not.** Map committed → `SttEvent {type:'final'}`, partial →
`{type:'partial'}`. Getting this backwards silently changes what "final" means across
adapters, which is precisely what the shared contract suite exists to catch.

Exact server event names are not knowable from here without a live call. **Accept either
the message-`type` discriminator or a boolean `is_final`/`committed` flag** and document in
the file header what was assumed — this is an adapter detail the operator's smoke test
resolves, and the tests should drive off the adapter's documented mapping rather than
guessing a vendor wire format the tests then enshrine.

## Acceptance criteria

- [ ] `name === 'elevenlabs'`
- [ ] API key resolves at construction from config, falling back to `ELEVENLABS_API_KEY`
- [ ] Connects via the injected `deps.wsFactory` to an ElevenLabs STT WebSocket URL carrying
      the model id, with header `xi-api-key`
- [ ] The connection/config frame pins `24000` and `silence_duration_ms: 500`
- [ ] Model is config-parameterized (`config.model` overrides the `scribe_v2_realtime`
      default) — no hardcoded model in the URL or body
- [ ] Each input `Int16Array` chunk produces exactly one outbound audio frame, in order, as
      the chunk arrives (the adapter does not drain the input first)
- [ ] A **partial** transcript message yields `SttEvent {type:'partial'}` and does NOT end
      the turn
- [ ] A **committed** transcript message yields exactly one `SttEvent {type:'final'}`, and it
      is the last event of the turn
- [ ] Two consecutive turns produce two `final` events, one per turn — a committed message
      never doubles up, and partials accumulating across a turn reset after each final
- [ ] An error message from the server throws a `ProviderError` whose message mentions
      `elevenlabs`
- [ ] Abort semantics match the project contract: an already-aborted signal yields nothing
      and opens NO connection; abort mid-stream closes the socket and the generator RETURNS
      cleanly (no throw)
- [ ] Socket close ends the generator cleanly
- [ ] `tStart`/`tEnd` are numbers on every event

## Test plan

New `src/server/providers/elevenlabs-stt.test.ts`, modelled on
`src/server/providers/openai-stt.test.ts`, driving a `FakeWsBase` subclass from
`src/server/providers/test-support.ts` via `recordingWsFactory`. **No network.**

## Attempt log
