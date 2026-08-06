---
id: 021
title: API server binds the client's port under the repo's own preview config
status: green
source: qa
depends_on: []
touches: [src/server/index.ts, package.json, .claude/launch.json]
iterations: 0
test_files: [src/server/index.test.ts]
branch: ""
---

## Repro

1. `preview_start` the `workbench` configuration from `.claude/launch.json` (it declares `port: 5173`)
2. The harness sets `PORT=5173` in the environment
3. `npm run dev` runs client and server concurrently; `src/server/index.ts` reads
   `Number(process.env.PORT ?? 8787)`
4. Server log: **`server listening on :5173`**

## Expected

The client dev server owns 5173; the API owns 8787, which is what `vite.config.ts` proxies to:

```ts
proxy: { '/api': 'http://localhost:8787', '/ws': { target: 'ws://localhost:8787', ws: true } }
```

## Observed

The API never binds 8787. Every `/api/*` request is ECONNREFUSED through the proxy, so the entire
Replay/storage half of the app is non-functional in the repo's own documented dev/QA path. QA had to
start the API separately with an explicit `PORT=8787` to proceed.

A developer running `npm run dev` from a shell with no `PORT` set is unaffected — which is exactly
what makes this easy to miss, and why it surfaced only under the preview harness.

## Suggested direction

The API should not silently inherit a generic `PORT` intended for the client. Options: give the
server its own variable (`API_PORT ?? PORT ?? 8787`), pin it in the `dev:server` script, or have
`.claude/launch.json` not export a `PORT` the server will pick up. Whichever is chosen, `npm run dev`
under the preview harness must leave the API reachable.

- iter 1: green. 16 tests (6 new + 10 guards).
- Fix: `API_PORT`-or-8787, generic `PORT` never consulted at any tier. Pinning the port in
  `dev:server` was rejected — it would fix only `npm run dev` and leave `npm start` exposed to any
  shell exporting `PORT`.
- **Accepted tradeoff:** a PaaS that injects `PORT` and expects the app to bind it (Heroku, Railway,
  Render, Fly) now needs `API_PORT` set explicitly. PRD §14 pins EC2 + Caddy, which reverse-proxies
  to a fixed port, so this is the right default here — documented in the file header.
- Mutation-checked: reintroducing `Number(process.env.PORT ?? 8787)` fails 3 tests.
- LIVE PROBE (orchestrator): with `PORT=5173` exported — the exact repro environment — the server
  logs `server listening on :8787`, `/api/health` answers there, and 5173 is not serving the API.
