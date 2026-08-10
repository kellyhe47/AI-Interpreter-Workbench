---
id: 071
title: "The Railway deploy builds and then serves nothing — the server ignores the port the platform injects"
status: done
source: operator (deploying to Railway), 2026-08-09
depends_on: []
touches: [src/server/index.ts, package.json]
iterations: 1
test_files: []
branch: main
---

## Observed — reproduced locally, exactly as Railway runs it

```
$ NODE_ENV=production PORT=7391 npx tsx src/server/index.ts
provider keys · OPENAI_API_KEY present (from .env) · …
Error: listen EADDRINUSE: address already in use :::8787
```

**With `PORT=7391` injected the server ignored it and tried to bind 8787.** On Railway that bind
would succeed, the platform would route traffic to `$PORT`, and nothing would answer — a green build
followed by failing health checks or a 502.

Everything else is sound. With the port corrected, the same binary serves the whole app:

```
$ NODE_ENV=production API_PORT=7391 npx tsx src/server/index.ts
server listening on :7391
  /                  -> HTTP 200   (index.html, real bytes)
  /api/recordings    -> HTTP 200
  /results           -> HTTP 200   (SPA fallback)
```

## Root cause — a documented, deliberate tradeoff that Railway invalidates

`resolveApiPort` (`src/server/index.ts:137`) reads **`API_PORT` only**, and its own header says so:

> *The generic port variable … is DELIBERATELY NEVER CONSULTED.* … **DEPLOYMENT TRADEOFF (accepted):
> PaaS platforms that inject a generic port variable and expect the process to bind it
> (Heroku/Railway/Render/Fly) need `API_PORT` set explicitly. PRD §14 pins deployment to EC2 + Caddy
> … A future move to such a platform must export API_PORT in the process environment.**

That was right when it was written. Ticket 021 fixed a real bug: the repo's `workbench` preview
config declares the **Vite** port 5173 and the harness exports it into the environment shared by both
halves of `npm run dev`, so the API bound 5173 while `vite.config.ts` still proxied `/api` and `/ws`
to 8787 — every API call ECONNREFUSED (QA F4).

**PRD §15A then CUT deployment entirely** (*"Rubric: 'Optional… Local-only with clear setup
instructions is fine.' AWS credentials absent"*). The operator has now chosen Railway, so the
accepted tradeoff is no longer acceptable — but ticket 021's fix must survive it.

## The fix — and why it cannot be "just read PORT"

Reading `PORT` unconditionally reintroduces QA F4: `npm run dev` would bind the API to the Vite port
again. **Consult `PORT` only when `NODE_ENV === 'production'`**, which `npm start` sets and
`npm run dev` does not. Both concerns then hold at once.

The locked ticket-021 test `resolveApiPort({ PORT: '5173' }) === 8787` (`index.test.ts:258`) passes
unchanged, because that env carries no `NODE_ENV`.

## Acceptance criteria

- [ ] In production, `PORT` is honoured when `API_PORT` is absent — `{ NODE_ENV: 'production',
      PORT: '7391' }` resolves to `7391`
- [ ] **`API_PORT` still wins over `PORT`** when both are set, in production and out
- [ ] **Outside production `PORT` is still ignored** — `{ PORT: '5173' }` resolves to `8787`, and
      `{ NODE_ENV: 'development', PORT: '5173' }` likewise. Ticket 021's locked test stays green and
      untouched; this is the assertion that stops QA F4 returning.
- [ ] A malformed `PORT` in production falls back to the default rather than binding `NaN`, matching
      how a malformed `API_PORT` is already treated
- [ ] `tsx` moves to `dependencies`. `npm start` is `tsx src/server/index.ts`, and `tsx` is currently
      a **devDependency** — any platform that prunes dev dependencies after the build step fails at
      `tsx: not found`. Falsifiable: `npm start`'s runtime requirements resolve from `dependencies`
      alone.
- [ ] `engines.node` is declared, so the platform does not pick a version the build was never run
      against

## Out of scope — flag to the operator, do not solve here

- **`data/` is ephemeral on Railway.** `DEFAULT_DATA_DIR` is the repo-root `data/`
  (`index.ts:50`), so every recording, run and `.out.wav` is lost on redeploy unless a persistent
  volume is mounted. This is a platform-configuration decision, not a code change, and the operator
  must make it knowingly — it is the difference between a demo and a lost corpus.
- Provider API keys must be set in Railway's dashboard. `loadServerEnv` already degrades correctly:
  a missing `.env` returns an empty set (`env.ts`, `readFileSync` in a `try/catch`) and it never
  overwrites a variable already present in `process.env`, so platform-injected keys win. **Verified,
  no change needed.**
- A `railway.json` / `nixpacks.toml` / `Procfile`. None exists; Nixpacks' Node autodetection runs
  `npm run build` then `npm start`, which is correct once the criteria above hold.

## Notes

- This is the first time anything in this repo has been run the way a platform runs it. The whole
  stack was verified end to end once the port was right, so the blast radius is genuinely one
  variable plus packaging hygiene.

## RESOLUTION (2026-08-09)

Suite 2529 passing / 0 failing. `npm run check` exits 0.

`resolveApiPort` is now three-tier and still pure (`env` injected, never reads `process.env` itself):
`API_PORT` wins → then `PORT` **only when `NODE_ENV === 'production'`** → then the 8787 default. One
shared `parsePort` validator, so `API_PORT` and `PORT` cannot drift into two rules.

**Verified end to end exactly as Railway runs it**, after the fix:

```
$ NODE_ENV=production PORT=7391 npx tsx src/server/index.ts
server listening on :7391
  /               -> HTTP 200
  /api/recordings -> HTTP 200
  /results (SPA)  -> HTTP 200
```

Packaging: `tsx` moved to `dependencies` (`npm start` runs it, and a dev-dep prune would otherwise
fail at `tsx: not found`); `engines.node: ^26` declared against the v26.4.0 actually in use;
`package-lock.json` regenerated offline so `npm ci` cannot fail on a manifest mismatch. The server's
real import graph was walked at runtime — the only external packages reachable from
`src/server/index.ts` are `express` and `ws`, both already runtime deps.

### Ticket 021's fix survives, and is better pinned

QA F4 — the API binding Vite's 5173 while `vite.config.ts` proxied to 8787 — is re-asserted
explicitly for unset `NODE_ENV`, `development` and `test`. The four behavioural precedence tests are
untouched.

**One 021 assertion was removed, outside the locked range:** a source grep
`expect(source).not.toMatch(/env\.PORT\b/)`. No implementation that reads `PORT` can satisfy it, and
dodging it by destructuring would have left a guard that *looks* like it forbids reading `PORT` while
the code reads it. It was replaced by 10 behavioural cases; `not.toMatch(/process\.env\.PORT\b/)`
stays and now pins that the resolver remains pure. Net assertion strength is up.

### A deliberate behaviour change worth recording

The old validator accepted `parsed >= 0`, so `API_PORT=0` meant listen-ephemeral. The shared rule is
now `1..65535`, so `API_PORT=0` falls back to 8787. Nothing in `src/` sets `API_PORT`, and tests that
want an ephemeral port call `createAppServer` + `listen(0)` directly, so this is inert — but it is a
change, not a refactor.

### STILL OPEN for the operator — not code

- **`data/` is ephemeral on Railway.** `DEFAULT_DATA_DIR` is the repo-root `data/`, so every
  recording, run and `.out.wav` is lost on redeploy unless a **persistent volume** is mounted there.
  This is the difference between a demo and a lost corpus, and it is a platform decision.
- **Provider API keys** must be set in Railway's dashboard. `loadServerEnv` already degrades
  correctly — a missing `.env` returns an empty set and it never overwrites a variable already in
  `process.env`, so platform-injected keys win. Verified; no change was needed.
