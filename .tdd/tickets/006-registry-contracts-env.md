---
id: 006
title: Registry entries for the new adapters + contract-suite provider list
status: pending
depends_on: [004, 005]
touches: [src/core/registry.ts, src/core/registry-adapters.test.ts, src/core/contracts/contracts.test.ts, .env.example]
iterations: 0
test_files: []
branch: ""
---

## Scope

Wire the ticket-004 and ticket-005 adapters into the two places that make a provider real:
the registry and the shared contract suite. Plus the `.env.example` note. Small ticket, three
files.

**Do NOT touch `src/core/contracts/index.ts`'s assertions.** Extending the suite means adding
entries to the provider list in `src/core/contracts/contracts.test.ts` — nothing else. *A new
adapter passing the suite unmodified is the definition of interchangeable* (PRD §13, manifest
Verification). If an adapter cannot pass unmodified, the adapter is wrong, not the suite.

`src/core/registry.test.ts` is the LOCKED v1 registry test — new registry coverage goes in
`src/core/registry-adapters.test.ts`, which is where the v1 run put the real-adapter entries.

## Scope detail

- `createStt`: add `'elevenlabs'` → `ElevenLabsStt`. `gpt-4o-mini-transcribe` needs **no new
  registry entry** — it is a config-only variant of the existing `'openai'` STT, which already
  accepts `config.model`.
- `createMt`: add `'anthropic'` → `AnthropicMt`.
- `createTts`: `'elevenlabs'` already exists; ElevenLabs Multilingual v2 is config-only via
  the `modelId` parameter that ticket 005 added.
- The unknown-name error must list **all** known names for that kind, as it does now.

## Acceptance criteria

- [ ] `createStt('elevenlabs', {apiKey:'k'})` returns an `ElevenLabsStt` with config forwarded
- [ ] `createMt('anthropic', {apiKey:'k'})` returns an `AnthropicMt` with config forwarded
- [ ] Options stay optional: `createStt('elevenlabs')` / `createMt('anthropic')` construct
- [ ] `createStt('openai', {model:'gpt-4o-mini-transcribe'})` forwards the model — the
      half-price same-vendor variant is reachable without a new registry name
- [ ] `createTts('elevenlabs', {modelId:'eleven_multilingual_v2'})` forwards the model id
- [ ] The unknown-name error for STT lists `fixture`, `openai`, **and** `elevenlabs`; for MT
      lists `fixture`, `openai`, **and** `anthropic`; TTS unchanged (`fixture`, `openai`,
      `elevenlabs`)
- [ ] `src/core/contracts/contracts.test.ts` registers `ElevenLabsStt` against
      `describeSttContract` and `AnthropicMt` against `describeMtContract`, each constructed
      with a **faked transport** (`wsFactory` / `fetchImpl`) so no test touches the network
- [ ] **Every assertion in `src/core/contracts/index.ts` is byte-identical to before** — the
      suite grew a provider, not a special case
- [ ] Both new adapters pass the suite, including the turn-final mapping assertion for STT
      (exactly one `final`, and it is last) and the streaming-flag assertion for MT
      (`streaming: true` ⇒ ≥2 chunks)
- [ ] `.env.example` gains `ANTHROPIC_API_KEY` and a note that the ElevenLabs key scope must
      include `speech_to_text` for Scribe (and `user_read` for the outstanding billing
      verification — PRD §6, §17 17d)

## Test plan

Extend `src/core/registry-adapters.test.ts` and `src/core/contracts/contracts.test.ts`. The
fixture-backed transports for the contract registrations must produce a well-formed turn
(partials then exactly one committed/final) so the shared assertions are meaningful rather
than vacuous.

## Attempt log
