---
id: 007
title: ElevenLabs Flash v2.5 TTS adapter (WS stream-input, true streaming text input)
status: green
depends_on: [001, 002, 003]
touches: [src/server/providers/elevenlabs-tts.ts, src/core/registry.ts, scripts/smoke-elevenlabs.mjs]
test_files: [src/server/providers/elevenlabs-tts.test.ts]
iterations: 0
---

## Scope
The one real provider exercising AsyncIterable<string> streaming input (validates PRD §6
decision 15). Preflight-verified: `wss://api.elevenlabs.io/v1/text-to-speech/{voiceId}/
stream-input?model_id=eleven_flash_v2_5&output_format=pcm_24000&auto_mode=true`, header
xi-api-key; init {text:' ', voice_settings}; text chunks {text}; close {text:''}; responses
{audio: base64}|{isFinal:true}|{error}. Default voice 21m00Tcm4TlvDq8ikWAM.

`ElevenLabsTts implements TtsProvider`: pushes text chunks to the socket AS THEY ARRIVE from
the input iterable (no concatenation); yields Int16Array chunks as audio messages arrive;
sends close message when input completes; completes on isFinal. WS constructor injected.
Register as 'elevenlabs' in registry (second real TTS provider — NOT part of any arm).
`scripts/smoke-elevenlabs.mjs` manual smoke.

## Acceptance criteria
1. Passes the SAME TTS contract suite as OpenAI TTS + fixture, unchanged (swappability proof).
2. Streaming input: with a mock WS echoing audio per text message, first yielded audio precedes
   completion of the input iterable; each input chunk produces a {text} frame in arrival order.
3. Close handshake: input end → {text:''} sent; isFinal → generator completes.
4. Abort mid-synthesis → socket closed, generator returns, no further yields.
5. {error} message or socket error → ProviderError with provider='elevenlabs'.
6. pcm_24000 base64 decoded to Int16Array without byte misalignment (odd-byte guard).
