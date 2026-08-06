---
id: 003
title: Shared provider contract suites (swappability proof)
status: green
depends_on: [001]
touches: [src/core/contracts/*]
test_files: [src/core/contracts/contracts.test.ts, src/core/contracts/index.ts]
iterations: 0
---

## Scope
`src/core/contracts/`: exported reusable suites `describeSttContract(name, factory)`,
`describeMtContract(name, factory)`, `describeTtsContract(name, factory)` — each registers a
vitest describe block asserting the interface contract. Every implementation of a stage runs
the SAME suite (PRD §12 #1). Fixtures pass them now; OpenAI + ElevenLabs adapters (tickets
006/007) will register against them with mocked transports.

Contract content:
- STT: yields SttEvents; ≥0 partials then exactly one `final` per turn; `final` maps to the
  provider's TURN-final signal (PRD §12 #6); abort → prompt return, no further yields.
- MT: yields string chunks; concatenation is the translation; `streaming` flag reported;
  non-streaming providers yield exactly once; abort honored.
- TTS: accepts AsyncIterable<string>; yields Int16Array; must begin yielding before input
  completes IF provider is streaming-capable, else after; abort honored; empty input → completes
  without yielding audio (no throw).

## Acceptance criteria
1. All three fixture providers pass their contract suites.
2. Suites are factory-parameterized and export cleanly (a later adapter file can
   `describeTtsContract('elevenlabs', factory)` with zero suite edits).
3. Turn-final mapping assertion exists in the STT suite and fails for a deliberately
   mis-mapped fixture (verified via an inline counter-example provider in the suite's own test).
4. Streaming assertion (PRD §12 #2): TTS suite asserts first audio chunk arrives before the
   text iterable has finished when streamingInput=true (fixture proves it).
