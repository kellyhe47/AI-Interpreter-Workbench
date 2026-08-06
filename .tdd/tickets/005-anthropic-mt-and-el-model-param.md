---
id: 005
title: Claude Haiku MT adapter + parameterize ElevenLabs TTS model_id
status: pending
depends_on: []
touches: [src/server/providers/anthropic-mt.ts, src/server/providers/anthropic-mt.test.ts, src/server/providers/elevenlabs-tts.ts, src/server/providers/elevenlabs-tts.test.ts]
iterations: 0
test_files: []
branch: ""
---

## Scope

Two independent provider changes, batched because both are small and both live in
`src/server/providers/`:

1. **ADD `src/server/providers/anthropic-mt.ts`** — an `MtProvider` backed by Claude
   Haiku 4.5, streaming. HTTP + SSE through an injected `deps.fetchImpl`, exactly like
   `openai-mt.ts`. No new npm dependency, no vendor SDK. `ANTHROPIC_API_KEY` is already
   present in `.env`.
2. **MODIFY `src/server/providers/elevenlabs-tts.ts`** — `model_id=eleven_flash_v2_5` is
   currently **hardcoded into the URL** (~line 87). Parameterize it via config, defaulting to
   Flash. Every other adapter already parameterizes its model; this one is the outlier, and
   the hardcode alone is what blocks ElevenLabs Multilingual v2 from being a menu option.

Registry wiring and contract-suite registration are ticket 006 — do NOT edit
`src/core/registry.ts` or `src/core/contracts/`.

## Design — Anthropic MT

Mirror `openai-mt.ts`; it is the exemplar for an SSE adapter.

- Class `AnthropicMt implements MtProvider`, `readonly name = 'anthropic'`,
  `readonly streaming = true`.
- `AnthropicMtConfig { apiKey?; model?; targetLang?; sourceLang?; maxTokens? }`; key resolved
  AT CONSTRUCTION from `config.apiKey ?? envVar('ANTHROPIC_API_KEY')`. Default model
  `claude-haiku-4-5`.
- `POST https://api.anthropic.com/v1/messages`, headers `x-api-key: <key>`,
  `anthropic-version: 2023-06-01`, `content-type: application/json`. Body carries
  `stream: true`, the model, `max_tokens`, a `system` translation instruction naming the
  target language, and one user message with the source text.
- **`temperature: 0`** — pinned by the PRD §8 controlled-variable register ("non-zero
  temperature makes translations irreproducible run to run"). Same reason `openai-mt` fixes
  its prompt. The system prompt must be **semantically equivalent** to `openai-mt.ts`'s, so
  the MT swap measures the model and not the prompt.
- SSE parsing: yield the `text` of each `content_block_delta` whose delta is a `text_delta`.
  Silently skip `message_start`, `content_block_start/stop`, `message_delta`, `message_stop`,
  `ping`, and any unknown event. Buffer partial lines — SSE events split across HTTP body
  chunks (`openai-mt.ts` already handles this; match it).
- HTTP 429 → `RateLimitError` (so `withRetry` engages). Other non-ok → `ProviderError`.
- Abort: signal propagated to fetch; already-aborted yields nothing; abort mid-stream returns
  the generator cleanly.

## Acceptance criteria

**Anthropic MT**
- [ ] `name === 'anthropic'`, `streaming === true`
- [ ] Key resolves at construction from config, falling back to `ANTHROPIC_API_KEY`
- [ ] POSTs to the Anthropic messages endpoint with `x-api-key` and `anthropic-version`
      headers (NOT an OpenAI-style `Authorization: Bearer`)
- [ ] Request body has `stream: true`, `temperature: 0`, the default model
      `claude-haiku-4-5`, and `config.model` overrides it
- [ ] The system prompt names the configured target language
- [ ] Streams multiple chunks: several `content_block_delta` text deltas yield in order, and
      their concatenation is the translation
- [ ] Non-text events (`message_start`, `ping`, `content_block_stop`, `message_stop`) yield
      nothing and do not throw; a malformed JSON frame is skipped, not fatal
- [ ] An SSE event split across two HTTP body chunks still yields once, intact
- [ ] HTTP 429 throws `RateLimitError`; another non-ok status throws `ProviderError`
- [ ] Already-aborted signal yields nothing; abort mid-stream ends the generator cleanly

**ElevenLabs TTS model parameter**
- [ ] Default construction still requests `model_id=eleven_flash_v2_5` — the existing
      behaviour is preserved exactly (this is a regression guard; it already passes)
- [ ] `new ElevenLabsTts({ modelId: 'eleven_multilingual_v2' })` puts that model id in the
      stream-input URL
- [ ] `output_format=pcm_24000` and the voice id remain as they were — only the model becomes
      configurable
- [ ] Every existing `elevenlabs-tts.test.ts` assertion still passes unchanged

## Test plan

New `src/server/providers/anthropic-mt.test.ts` modelled on `openai-mt.test.ts`, using
`recordingFetch` + `chunkedBodyResponse`/`sseBody`/`hangingBodyResponse` from
`test-support.ts`. **No network.** Extend `elevenlabs-tts.test.ts` with the model-id cases.

## Attempt log
