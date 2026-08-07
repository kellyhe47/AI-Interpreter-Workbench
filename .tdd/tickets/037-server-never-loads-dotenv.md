---
id: 037
title: The server never loads .env — every real provider call fails, Live is dead on arrival
status: green
source: qa-live
depends_on: []
touches: [src/server/env.ts, src/server/env.test.ts, src/server/index.ts, AGENTS.md]
iterations: 0
test_files: [src/server/env.test.ts]
branch: ""
---

## Severity: HIGH — the product's headline feature has never worked from a normal start

Reported by the operator: "I tried starting a session in Live mode and it starts recording but
never picks up any of my utterances and no translation is run."

## Repro

1. `npm run dev`
2. Live → Start microphone (Realtime, the default arm)

## Observed

The session reaches `mic allowed · connected · listening`, the input meter moves, and then the arm
card shows **`failed`** with *"opaque failure — no stage attribution · session still running"*.
No utterance is ever transcribed and no translation runs.

Direct probe of the endpoint the Realtime transport calls first:

```
POST /api/realtime-token  ->  500
{"error":"OPENAI_API_KEY is not configured on the server"}
```

…even though `.env` contains `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` and `ANTHROPIC_API_KEY`.

## Root cause

**Nothing ever loads `.env`.** Verified across the whole repo:

- `dotenv` is **not a dependency**
- no `--env-file` flag in any npm script — `dev:server` is plain `tsx watch src/server/index.ts`
- no `process.loadEnvFile()` call anywhere in `src/`

So `process.env.OPENAI_API_KEY` is `undefined` in the server process on every normal start, for
everyone. `src/server/token.ts` correctly returns a typed 500, the Realtime transport correctly
treats a non-ok token response as a start failure, and the UI correctly renders the opaque
failure — every layer behaves as designed on top of an env that was never populated.

The smoke scripts hid it: `scripts/smoke-openai.mjs` says *"(needs OPENAI_API_KEY in env)"* and
fails loudly if unset, so whoever ran them exported the key by hand in that shell. The server was
never given the same treatment.

**Confirmed by bisection:** with `set -a; . ./.env; set +a` before starting the server, the same
endpoint returns **200** with a real ephemeral key, and the Live Realtime card goes from `failed`
to **`ready`** in the browser.

## Why 1,265 green tests never caught it

Every test runs on fixtures and injected seams; none reads a real key, by deliberate policy
("No real API calls in vitest or the dev loop"). This is precisely the
*unit-environment-green-is-not-runtime-green* class, and it is the second time in this project a
defect has lived entirely in the gap between the two (the first was ticket 021's port).

QA never caught it either: six iterations ran `?fixture=1` because a QA browser has no grantable
microphone, so no pass ever exercised a real provider call.

## Acceptance criteria

- [ ] The server loads `.env` from the repo root on startup, before any route reads `process.env`
- [ ] **A real environment variable WINS over the file** — a value already in `process.env` is not
      clobbered (deployment sets real env vars; `.env` is a dev convenience)
- [ ] A **missing** `.env` is not an error: a deployed server with real env vars and no file starts
      normally
- [ ] A malformed line does not crash startup
- [ ] Loading is skipped under `NODE_ENV=test` so the suite's env stays hermetic and no test can
      accidentally acquire a real key
- [ ] `POST /api/realtime-token` returns 200 after a plain `npm run dev` with a populated `.env`
- [ ] No new dependency — Node's built-in `process.loadEnvFile` is available (node v26 here)

## Follow-up this exposes (do NOT fix in this ticket)

**There is no startup diagnostic for missing keys.** The server starts happily with no providers
configured and the first sign is an opaque in-session failure minutes later. Consider a startup
log line naming which of the three keys are present — absent keys are a legitimate state (an
ElevenLabs-less run is fine), so this is a warning, never a hard failure. File separately.

## Attempt log

- Green. Suite 1271/69 (+6); both tsconfigs clean.
- `src/server/env.ts` — hand-rolled rather than Node's built-in `process.loadEnvFile`, because that
  built-in throws on a missing file and gives no way to report which names were set.
- Wired at the process entrypoint in `src/server/index.ts`, BEFORE any route reads `process.env`,
  and inside the existing `NODE_ENV !== 'test'` guard so the suite stays hermetic and no test can
  accidentally acquire a real key.
- **Verified from a genuinely clean environment**, not just a passing test:
  `env -u OPENAI_API_KEY -u ELEVENLABS_API_KEY -u ANTHROPIC_API_KEY npx tsx src/server/index.ts`
  then `POST /api/realtime-token` -> **200** with a real ephemeral key. Before the fix, 500.
- Confirmed in the operator's own Chrome: the Live Realtime card went from **`failed`**
  ("opaque failure — no stage attribution") to **`ready`**.
- Mutation-checked, three properties:
  | mutation | result |
  |---|---|
  | the file clobbers the real environment | 2 red |
  | a missing file throws | 1 red |
  | values leak into the returned set | 1 red |

### Diagnostic note — my first hypothesis was wrong, and checking is what caught it

I reasoned from the code that the `AudioContext` is constructed AFTER `await getUserMedia(...)`,
i.e. outside the user-gesture window, so Chrome would leave it `suspended` and `onaudioprocess`
would never fire — which fits "records but hears nothing" perfectly, and `playback.ts` calls
`resume()` while the capture path never does.

Instrumenting the real page disproved it: context `running`, 412 frames captured, **407
non-silent**. Capture was fine all along. Had I "fixed" the plausible bug I would have added a
pointless `resume()`, shipped it, and left Live just as broken.

The capture path still has no `resume()` and `CaptureAudioContextLike` still lacks it. That is a
latent risk on a browser that suspends more aggressively, but it is NOT this defect and is not
being fixed on spec.
