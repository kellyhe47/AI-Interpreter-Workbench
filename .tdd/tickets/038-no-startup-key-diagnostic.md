---
id: 038
title: No startup diagnostic for missing provider keys — absence surfaces as an opaque in-session failure
status: green
source: qa-live
depends_on: [037]
touches: [src/server/index.ts, src/server/env.ts]
iterations: 0
test_files: [src/server/startupDiagnostic.test.ts]
branch: ""
---

## Why

Split out of ticket 037. Even with `.env` loading fixed, a server started without a given provider
key starts perfectly happily and says nothing. The first sign is an opaque failure inside a Live
session minutes later — which is precisely how 037 stayed invisible.

`loadServerEnv` already returns the NAMES it set (never values) specifically so this is cheap.

## Acceptance criteria

- [ ] On startup the server logs which provider keys are present and which are absent, by NAME ONLY
- [ ] **No key value, prefix, suffix or length is ever logged** — a secret must not reach a log line
- [ ] Absence is a WARNING, never a hard failure: an ElevenLabs-less run is a legitimate
      configuration and the server must still start
- [ ] Silent under `NODE_ENV=test`
- [ ] The line distinguishes "loaded from .env" from "already in the environment", so a deployment
      can confirm its real env vars are the ones in force

## Notes

Consider also surfacing it in the product: a Live session whose arm needs an absent key could say
so before the operator speaks for five minutes, rather than failing opaquely afterwards. That is a
product decision, not a logging one — raise it rather than assuming.

## Attempt log

- Green in one pass, batched with 033.
- `describeProviderKeys(loaded, env)` is a PURE function beside `loadServerEnv`; `index.ts` does
  nothing but log `report.lines` at `report.level`. That is what makes it testable without spawning
  a process or capturing global stdout.
- **Silence under test is a property of the REPORT, not a guard in `index.ts`** — `lines` is `[]`
  when the PASSED env says `NODE_ENV === 'test'`, while `keys`/`missing` stay populated so the
  classification itself remains testable. Reading ambient `process.env` would have made the function
  silent inside the suite and therefore untestable.
- **No secret can reach the report by construction:** the only read of a value anywhere is the
  emptiness test `(env[name] ?? '') !== ''`, whose result is a boolean. Every string in the report
  is built from `PROVIDER_KEY_NAMES` constants plus three fixed literals. No value is stored, no
  length computed, no digit appears in the line.
- An **empty-string** env value counts as ABSENT — a bare `FOO=` line in `.env` sets the name
  without configuring anything, and reporting it present would claim the server is configured when
  the very next provider call will fail. The ticket left this open; it is now asserted.
- Absence is a WARNING, never a failure: a guard test builds the real server with all three keys
  deleted and confirms `/api/health` still answers.
- Mutation-checked:
  | mutation | result |
  |---|---|
  | the report leaks the key VALUE where a boolean belongs | 5 red — the load-bearing secret test fires |
  | an empty-string value counts as PRESENT | 1 red |

### Still open — a product decision, deliberately not taken here

Whether Live should REFUSE to start an arm whose key is absent, rather than letting the operator
speak for five minutes and then fail opaquely. No test asserts anything in the client. Raise it with
the operator rather than assuming.
