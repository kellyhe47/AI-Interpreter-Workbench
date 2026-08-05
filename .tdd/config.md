# TDD run config

- **Working branch:** main (never pushed)
- **Test commands (verified against probes 2026-08-04):**
  - Full suite: `npx vitest run` (root: repo root; includes `src/**/*.test.{ts,tsx}`; node env, jsdom for `src/client/**`)
  - Single file/dir: `npx vitest run <path>`
  - Typecheck: `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.server.json`
- **Stack:** Vite + React 18 + TS (client), Express + ws + tsx (server), Vitest + RTL/jsdom.
- **Layout:** `src/core` (shared interfaces/fixtures/decorators/protocol — isomorphic, no DOM/node deps), `src/server`, `src/client`, `scripts/` (smoke/corpus — not in vitest).
- **Rules:** tests colocated `*.test.ts(x)`. No real API calls in tests. Keys via .env (gitignored).
- **Sample rate: 24 kHz PCM16 mono both directions** (preflight-verified floor for OpenAI transcription).
- Worktrees for parallel waves under `.tdd/worktrees/` (gitignored).
