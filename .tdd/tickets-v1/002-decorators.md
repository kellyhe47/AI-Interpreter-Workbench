---
id: 002
title: withTiming / withRetry / withTimeout decorators
status: green
depends_on: [001]
touches: [src/core/decorators/*]
test_files: [src/core/decorators/decorators.test.ts]
iterations: 0
---

## Scope
`src/core/decorators/`: cross-cutting decorators applying uniformly to any of the three stage
interfaces (PRD §6): `withTimeout(provider, ms)` (aborts underlying call, throws TimeoutError),
`withRetry(provider, {retries, backoffMs})` (retries ONLY on RateLimitError/429 with backoff;
other errors propagate), `withTiming(stageName, provider, sink)` (emits {stage, event, t} marks:
call start, first yield, completion — the sink feeds the utterance record). Decorators return
the same interface shape so they compose: `withTiming('stt', withRetry(withTimeout(p, 5000)))`.

## Acceptance criteria
1. Instrumentation validation (PRD §12 #5): a fixture configured with 200 ms first-yield delay
   measured by withTiming reports 200 ms ±25 ms (fake timers exact or real timers tolerance).
2. withTimeout: provider that never yields → TimeoutError at ~ms; underlying generator's signal
   aborted (fixture observes abort).
3. withRetry: fixture failing twice with 429 then succeeding → succeeds, 3 attempts observed,
   backoff waits between; non-429 error → no retry, propagates after 1 attempt.
4. Composition: all three composed on one fixture still yields correct output and reports
   timing; caller AbortSignal propagates through all layers.
5. Decorators are interface-generic: same helpers work on stt/mt/tts fixture (type-level +
   runtime test on at least stt and tts).
