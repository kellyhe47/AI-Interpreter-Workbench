# RUN_LOG — overnight autonomous build

Run started: 2026-08-04 ~23:00 local. Operator asleep; instructions: build Arms A + B fully,
ElevenLabs TTS adapter (not an arm), fixtures everywhere, $5 hard cap, preflight → TDD build →
QA loop until convergence.

## Budget ledger (hard cap $5.00)

| When | What | Est. cost |
|---|---|---|
| 08-04 23:30 | Preflight: gpt-4o-mini-tts input clip (78 chars) | ~$0.001 |
| 08-04 23:35 | Preflight: gpt-realtime-mini spike (79 in / 134 out tokens) | ~$0.003 |
| 08-04 23:40 | Preflight: gpt-4o-transcribe spike ×2 (1 rejected free, 1 run) | ~$0.001 |
| 08-04 23:45 | Preflight: gpt-4o-mini MT spike (58 tokens) | ~$0.0001 |
| 08-04 23:45 | Preflight: ElevenLabs Flash v2.5 WS (79 chars, quota not $) | ~$0.004 equiv |
| | **Running total (OpenAI $)** | **~$0.005** |

## 2026-08-04 23:00 — Kickoff

- Read PRD.md, design handoff README, dc.html mock source, all token CSS, rubric PDF.
- Scope confirmed: Arms A (Realtime WebRTC) + B (OpenAI cascade), fixture providers for every
  stage, ElevenLabs TTS as second real TTS provider (validates AsyncIterable<string> streaming
  input), no Deepgram adapter, no Arm C composition.
- Keys present in .env: OPENAI_API_KEY, ELEVENLABS_API_KEY, ANTHROPIC_API_KEY.
- Plan: Phase 1 preflight (docs checks free → 2 throwaway spikes + ElevenLabs smoke),
  Phase 2 /tdd-orchestrator against PRD, Phase 3 /manual-qa loop to convergence.

## 2026-08-04 23:20 — Preflight: docs verification (free, no spend)

**Realtime (Arm A):**
- Ephemeral token: POST `https://api.openai.com/v1/realtime/client_secrets`, body
  `{session: {type:"realtime", model, audio:{output:{voice}}}}`. SDP exchange: POST
  `https://api.openai.com/v1/realtime/calls` with `Authorization: Bearer <ephemeral>`,
  `Content-Type: application/sdp`. Events over `oai-events` data channel. Matches PRD §4.
- GA event names (changed from beta — PRD §7 wrote `response.audio.delta`, GA is
  **`response.output_audio.delta`**): `input_audio_buffer.speech_started/.speech_stopped`,
  `response.created/.done`, `response.output_audio.delta`, `response.output_audio_transcript.delta`,
  `conversation.item.input_audio_transcription.delta/.completed`. **Deviation logged:** adapters
  use GA names.
- Turn detection GA shape: `session.audio.input.turn_detection = {type:"server_vad",
  silence_duration_ms: 500, ...}` — PRD's pinned 500 ms is expressible. ✓
- Docs reference `gpt-realtime-2.1` as current snapshot; `gpt-realtime` / `gpt-realtime-mini`
  aliases to be confirmed live in spike.

**Cascade (Arm B):**
- Transcription over realtime WS: session `{type:"transcription", audio:{input:{format:
  {type:"audio/pcm", rate:24000}, transcription:{model}, turn_detection}}}`. Docs now push
  `gpt-live-transcribe` ($0.017/min); **`gpt-4o-transcribe` still listed at $0.006/min** — PRD's
  pick stands, spike confirms it's accepted in a transcription session.
- Docs show 24 kHz PCM for transcription input; PRD §4 says 16 kHz up. Spike tests 16k
  acceptance; if 24k-only, capture at 24 kHz mono up (deviation, minor bandwidth cost).
- TTS: POST `/v1/audio/speech`, `gpt-4o-mini-tts`, `response_format:"pcm"` = raw 24 kHz s16le,
  chunked-transfer streaming. Matches PRD (24 kHz down). ✓
- MT: `gpt-4o-mini` chat completions streaming. ✓

**ElevenLabs:**
- WS `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?model_id=eleven_flash_v2_5`,
  init msg `{text:" ", voice_settings, generation_config:{chunk_length_schedule}}`, chunks
  `{text}`, flush `{text:"", flush:true}` — close `{text:""}`. Audio back as base64 +
  `isFinal`. `output_format` query param exists; pcm option list not documented — smoke test
  will request `pcm_24000` and verify.
- **Billing aggregate-vs-per-chunk is not documented anywhere.** Will determine empirically:
  read `/v1/user/subscription` character_count before/after a 3-chunk streamed synthesis.

**Pricing re-verified (all match PRD §5):** gpt-realtime $32/$64 per M audio tokens;
gpt-realtime-mini $10/$20; gpt-realtime-translate $0.034/min; gpt-4o-transcribe $0.006/min;
gpt-4o-mini $0.15/$0.60 per M; gpt-4o-mini-tts $12/M audio-out tokens.

## 2026-08-04 23:45 — Preflight: live spikes (throwaway code in scratchpad, not committed)

All four paths verified with real calls:

1. **gpt-4o-mini-tts** — `response_format:"pcm"` chunked streaming works; 4.4 s clip, first
   byte 1.24 s cold. This clip became the spike input audio.
2. **Realtime, `gpt-realtime-mini` over WS** — alias accepted. GA session shape + server_vad
   silence_duration_ms:500 accepted. Perfect ES translation of the clip. Event names observed
   live exactly as docs: `input_audio_buffer.speech_started/stopped/committed`,
   `response.created`, `response.output_audio.delta` (13), `response.output_audio_transcript.delta`,
   `response.done` w/ usage. Model interval (speech_stopped→first audio delta): 602 ms.
3. **Transcription session, `gpt-4o-transcribe`** — accepted (PRD's model pick stands despite
   docs now promoting gpt-live-transcribe). **16 kHz input rejected**:
   `integer_below_min_value … Expected >= 24000`. → **Deviation: transport is 24 kHz PCM16 up**
   (PRD §4 said 16 kHz). 24 kHz run: perfect transcript, 15 partial deltas, turn-final via
   `…input_audio_transcription.completed`, stt interval 994 ms.
4. **ElevenLabs `eleven_flash_v2_5` stream-input WS** — `output_format=pcm_24000` works; text
   sent as 3 timed chunks (validates AsyncIterable<string> input shape); first audio 387 ms
   after connect; 4.88 s Spanish audio out.

**Blocker (needs operator): ElevenLabs aggregate-vs-per-chunk billing could not be verified
empirically.** The API key is TTS-scoped only — `/v1/user/subscription` and `/v1/history` both
401 (`missing_permissions: user_read / speech_history_read`). Docs don't state the answer
either. Until verified (dashboard usage view, or re-scope the key), no ElevenLabs cost figure
may be reported; the adapter is built and smoke-tested regardless. Logged per PRD §5 known
cost trap.

**Interface freeze:** with the above observed, PRD §6 interfaces freeze as written, with the
single amendment that the pipeline sample rate is 24 kHz end-to-end (up and down).
