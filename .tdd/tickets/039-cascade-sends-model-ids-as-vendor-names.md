---
id: 039
title: Cascade passes MODEL ids where the registry expects VENDOR names — Arms B and C cannot run at all
status: green
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

## Attempt log

- Green in one implementation pass, 27 red -> 0. Suite 1300/71; both tsconfigs clean; build clean.
- `src/core/models.ts` holds a per-kind table `Record<ProviderKind, Record<model, {vendor, optionKey}>>`.
  Per-kind nesting makes kind isolation STRUCTURAL rather than a guard, so
  `resolveModel('tts','gpt-4o-transcribe')` cannot resolve.
- **The `modelId` trap is closed by construction:** the option key is stored per table entry beside
  the vendor and the options object is built by computed key from that entry. There is no code path
  where a uniform `model` could be substituted. Verified against the adapters —
  `elevenlabs-tts.ts:98` reads `config.modelId`, `elevenlabs-stt.ts:140` reads `config.model`, so
  ElevenLabs STT and TTS genuinely differ.
- Known-model lists are derived from `MENUS`, so a menu entry added without a mapping fails loudly
  and names itself.
- `fixture` escapes BEFORE the lookup (the test-writer found this; without it the existing
  `ws.test.ts` fixture path dies).
- `resolveTriple` is called inside `ws.ts`'s existing try/catch, so an unknown MODEL now inherits
  the same "error frame, socket stays open" contract unknown vendors already had.
- Untouched as required: `registry.ts` (still vendor-keyed), `src/core/contracts`, `orchestrator.ts`.
- Mutation-checked, four properties, each independently load-bearing:
  | mutation | result |
  |---|---|
  | ElevenLabs TTS `modelId` collapsed to `model` | 8 red — the trap is defended |
  | model dropped entirely (vendor-only "fix") | 17 red — B/C cannot collapse silently |
  | `ws.ts` passes the raw wire string again (the original bug) | 4 red |
  | fixture escape removed | 3 red |
- Implementer's judgement worth keeping: it considered asserting at MODULE LOAD that every `MENUS`
  entry has a mapping, and rejected it because a throw during import would take down both bundles
  over one bad menu edit. The derived error list gives the same loudness at point of use.
- Ticket 026 stays open. The test-writer correctly disagreed with this ticket's note that 026 would
  become "trivially fixable": resolution happens server-side inside `ws.ts` and nothing about the
  resolved pair travels back to the client or onto the stored record. 026 still needs its own
  plumbing decision.
