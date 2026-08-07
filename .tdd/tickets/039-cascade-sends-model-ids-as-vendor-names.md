---
id: 039
title: Cascade passes MODEL ids where the registry expects VENDOR names — Arms B and C cannot run at all
status: pending
source: qa-live
depends_on: []
touches: [src/server/ws.ts, src/core/registry.ts, src/core/arms.ts]
iterations: 0
test_files: [src/core/models.test.ts, src/server/ws.providers.test.ts]
branch: ""
---

## Severity: CRITICAL — two of the three arms have never worked against real providers

Operator report, Live → Cascade → Start session:

> `Unknown STT provider "gpt-4o-mini-transcribe". Known providers: fixture, openai, elevenlabs — session still running`

## Root cause

`src/core/registry.ts` is keyed by **vendor**, and says so in its own header:
*"'gpt-4o-mini-transcribe' is createStt('openai', {model})"*. Valid keys are
`fixture | openai | elevenlabs` (MT: `fixture | openai | anthropic`).

`src/server/ws.ts:157-159` passes the wire's provider triple straight through:

```ts
stt: createStt(msg.providers.stt),
mt:  createMt(msg.providers.mt),
tts: createTts(msg.providers.tts),
```

But the client sends `config.providers` — the ARM TRIPLE from `src/core/arms.ts`, which is
**model ids**: `gpt-4o-transcribe`, `gpt-4o-mini`, `gpt-4o-mini-tts`. **There is no model→vendor
mapping anywhere in the repo.**

So the failure is not specific to `gpt-4o-mini-transcribe` — **every** cascade model fails,
including Arm B's default triple. `browserDeps.ts:164` shows Replay uses the same
`CascadeTransport`, so this kills cascade in **both** Live and Replay: Arms B and C cannot produce
a single real run.

## The second half of the bug — do not fix only the first

`createStt(msg.providers.stt)` passes **no options**, so even with a correct vendor the MODEL is
discarded and each adapter would fall back to its own default. Arms B and C differ **only** by TTS
model (`gpt-4o-mini-tts` vs `eleven_flash_v2_5`). A naive "map to vendor" fix would therefore make
Arm B and Arm C run the *same configuration* while still being labelled and reported as different
arms — silently destroying Experiment 2 and producing a confident, wrong finding.

That is a worse outcome than the current loud failure. The model must be threaded through to
`providerOptions`, and a test must pin that B and C actually differ on the wire.

## Why the suite never caught it

`fixture` is BOTH a valid vendor key AND the test/fixture-mode default, so `createStt('fixture')`
resolves and every test passes. The model-id path is unexercised by construction — the same
real-runtime gap that hid ticket 021 (port) and ticket 037 (env). Third occurrence.

## Acceptance criteria

- [ ] A cascade session starting with Arm B's triple connects and runs
- [ ] Arm C's triple runs and **reaches ElevenLabs for TTS**, not OpenAI
- [ ] The resolved (vendor, model) pair is asserted for every entry in `MENUS` — all three STT, both
      MT, all three TTS models map to the right vendor AND carry their model through
- [ ] **Arm B and Arm C produce demonstrably different provider configurations on the wire** — a
      test that fails if the model is dropped
- [ ] An unknown model still fails loudly with a named error; do not silently default
- [ ] `fixture` continues to resolve, so fixture mode is unaffected
- [ ] `src/core/contracts` is untouched (AGENTS.md: adapters must keep passing it unchanged)

## Notes

- The mapping belongs in `src/core/` beside `arms.ts`/`registry.ts` so client and server agree, not
  in `ws.ts`.
- `LiveSession` currently records the CONFIGURED triple (ticket 026, knowingly deferred). Once the
  wire carries a resolved vendor+model, revisit 026 — it may become trivially fixable.
