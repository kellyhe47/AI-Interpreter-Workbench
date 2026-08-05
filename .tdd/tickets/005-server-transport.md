---
id: 005
title: Server WS transport + ephemeral token endpoint + static serving
status: pending
depends_on: [004]
touches: [src/server/index.ts, src/server/ws.ts, src/server/token.ts]
test_files: []
iterations: 0
---

## Scope
- `src/server/ws.ts`: WebSocket endpoint `/ws/cascade` speaking `src/core/protocol.ts`: binary
  frames = PCM16 24 kHz audio in; JSON frames = control. Bridges socket → cascade orchestrator
  (ticket 004) with providers built from the client-supplied config ({stt:'fixture'|'openai',
  ...}); server refuses unknown provider names cleanly. Emits protocol events back (audio as
  base64 JSON chunks). Socket close aborts the session. Multiple sequential utterances on one
  socket. Testable via injected fake orchestrator/providers + `ws` client against an ephemeral
  port.
- `src/server/token.ts`: POST `/api/realtime-token` → calls
  `https://api.openai.com/v1/realtime/client_secrets` (body {session:{type:'realtime', model,
  audio:{output:{voice}}}}) with OPENAI_API_KEY from env, returns {value, model} to the browser.
  Model from request body, default `gpt-realtime-mini` (dev default per PRD §5), allowlist
  [gpt-realtime, gpt-realtime-mini]. fetch injected/mockable; no real call in tests. 500 with
  clear message when key missing.
- `src/server/index.ts`: wire ws + token + health + (prod) static dist/client serving.

## Acceptance criteria
1. WS integration (fixture providers, real ws client in test): connect → configure → send PCM
   binary → receive source-partial, source-final, target-delta(s), audio-chunk(s),
   utterance-complete with 5-interval timing record.
2. Binary frames route to orchestrator as Int16Array of correct length (no byte mangling).
3. Unknown provider name in configure → protocol error event, socket stays open.
4. Socket close mid-utterance aborts orchestrator (fake observes abort ≤100ms).
5. Token endpoint: mocked fetch → 200 {value:'ek_...'}; missing env key → 500 {error};
   disallowed model → 400.
6. Health endpoint still 200.
