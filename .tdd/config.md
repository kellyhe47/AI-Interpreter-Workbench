# TDD run config — v2 (Replay flow)

- **Working branch:** main (commits land here, **never pushed**)
- **Plan source:** `CHANGE_MANIFEST.md` (authoritative scope + Sequence) + `PRD.md` §6/§7/§8/§10/§12/§13
- **Design spec:** `design_handoff_interpreter_workbench/README.md` + `interpreter-workbench-v2.dc.html`
- **Test commands (re-verified 2026-08-06 by probe):**
  - Full suite: `npx vitest run` (repo root; `src/**/*.test.{ts,tsx}`; node env, jsdom for `src/client/**`)
  - Single file/dir: `npx vitest run <path>`
  - Typecheck: `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.server.json`
  - Build: `npm run build`
- **Baseline at v2 start:** 34 test files / 461 tests green; both typechecks clean.
- **Stack:** Vite + React 18 + TS (client), Express + ws + tsx (server), Vitest + RTL/jsdom.
- **Layout:** `src/core` (isomorphic — no DOM/node imports), `src/server`, `src/client`, `scripts/`.
- **Rules:** tests colocated `*.test.ts(x)`. No real API calls in tests, ever. Keys via .env.
- **Sample rate: 24 kHz PCM16 mono** both directions.
- Worktrees for parallel waves under `.tdd/worktrees/` (gitignored).
- `.tdd/tickets-v1/` is the archived v1 board — historical, never reconciled against.

## Wave plan

| Wave | Tickets | Mode |
|---|---|---|
| — | 001 | sequential (everything depends on `deriveArmTag`) |
| W1 | 002 ‖ 004 ‖ 005 ‖ 007 | parallel worktrees |
| W2 | 003 ‖ 006 ‖ 010 | parallel worktrees |
| W3 | 008 ‖ 011 | parallel worktrees |
| W4 | 009 ‖ 012 | parallel worktrees |
| W5 | 013 ‖ 015 ‖ 017 | parallel worktrees |
| — | 014 | sequential |
| — | 016 | sequential (integrates all four views) |
