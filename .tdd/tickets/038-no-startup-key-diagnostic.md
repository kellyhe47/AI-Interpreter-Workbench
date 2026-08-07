---
id: 038
title: No startup diagnostic for missing provider keys — absence surfaces as an opaque in-session failure
status: pending
source: qa-live
depends_on: [037]
touches: [src/server/index.ts, src/server/env.ts]
iterations: 0
test_files: []
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
