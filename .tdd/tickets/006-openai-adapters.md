---
id: 006
title: OpenAI real adapters — STT (transcription WS), MT (chat stream), TTS (speech stream)
status: pending
depends_on: [001, 002, 003]
touches: [src/server/providers/openai-stt.ts, src/server/providers/openai-mt.ts, src/server/providers/openai-tts.ts, src/core/registry.ts, scripts/smoke-*.mjs]
test_files: []
iterations: 0
---

## Scope
Preflight-verified facts (RUN_LOG 2026-08-04): transcription session over
`wss://api.openai.com/v1/realtime?intent=transcription`, session.update
{type:'transcription', audio:{input:{format:{type:'audio/pcm', rate:24000},
transcription:{model:'gpt-4o-transcribe'}, turn_detection:{type:'server_vad',
silence_duration_ms:500}}}}; events `conversation.item.input_audio_transcription.delta` /
`.completed` (turn-final), `input_audio_buffer.speech_started/stopped`. TTS: POST
/v1/audio/speech {model:'gpt-4o-mini-tts', response_format:'pcm'} → chunked 24 kHz s16le.
MT: chat completions stream, system prompt "Translate from X to Y. Output only the translation."

- `OpenAiStt implements SttProvider`: feeds input iterable as base64 append events; maps
  `.delta`→partial, `.completed`→final (TURN-final per PRD §7); `speech_stopped` timestamp
  surfaced via event metadata for vad_fired. WS constructor injected (mock in tests).
- `OpenAiMt implements TranslationProvider` (streaming=true): yields content deltas; fetch
  injected.
- `OpenAiTts implements TtsProvider`: concatenates its AsyncIterable input to one string (this
  provider has no streaming text input — PRD §6 rule 2 'less capable providers concatenate
  internally'), single request, yields Int16Array chunks as they stream down; fetch injected.
- Register all in registry as 'openai'. Keys read from env at construction, never logged.
- `scripts/smoke-openai.mjs`: one manual real-call smoke per path (NOT in vitest).

## Acceptance criteria
1. All three pass their shared contract suites with mocked transports (STT: fake WS emitting
   recorded GA event sequences; MT: fake SSE fetch; TTS: fake chunked body).
2. STT turn-final mapping: `.completed` → SttEvent final; `.delta` → partial (PRD §12 #6).
3. STT 16k unsupported: constructor/opts pin rate 24000 (regression vs preflight finding).
4. MT non-content frames (role delta, usage frame, [DONE]) skipped without error.
5. TTS: input iterable of 3 chunks produces exactly one HTTP request whose input is the
   concatenation; odd-length trailing byte handled (no Int16Array misalignment crash).
6. Abort mid-stream on each: transport closed/aborted (mock observes), generator returns.
7. 429 from MT/TTS fetch → RateLimitError (so withRetry engages); timeout via signal →
   TimeoutError semantics preserved through adapter.
