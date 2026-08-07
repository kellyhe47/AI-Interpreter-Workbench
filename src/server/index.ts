/**
 * HTTP + WebSocket entry point.
 *
 * ============================ APP FACTORY SEAM (normative) =================
 *   export interface AppDeps {
 *     storage?: Storage;      // backs /api/recordings, /api/runs and
 *                             // /api/blind-comparisons
 *     clientDist?: string;    // production SPA dir
 *   }
 *   createApp(deps?)        -> express.Express
 *   createAppServer(deps?)  -> http.Server with /ws/cascade attached
 *   app                     -> createApp(), the process-wide default
 *
 * THE APP IS BUILT BY A FACTORY, NOT AT MODULE SCOPE, because the REST routers
 * need an injected `Storage`: a module-level singleton could only ever talk to
 * the repo's real `data/` directory, so tests would write into it. `deps` is
 * fully optional, so the production call site is still `createAppServer()`.
 *
 * `createApp` READS process.env.NODE_ENV AT CALL TIME, never at module load —
 * the production SPA branch is only reachable (and only testable) that way.
 * Building the default `Storage` touches no filesystem: `createStorage` merely
 * closes over paths, so importing this module is free of side effects beyond
 * the listener below.
 *
 * ROUTE ORDER IS LOAD-BEARING: /api/health, the token route and the three REST
 * routers are all mounted BEFORE the production SPA catch-all, and the
 * catch-all itself excludes /api/ and /ws/ — an SPA that swallowed
 * /api/recordings would answer index.html to every API call in production only.
 */
import express from 'express'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createBlindComparisonsRouter,
  createLiveSessionsRouter,
  createRecordingsRouter,
  createRunsRouter,
  createWerScoresRouter,
} from './routes'
import { createStorage } from './storage'
import { describeProviderKeys, loadServerEnv } from './env'
import type { Storage } from './storage'
import { createTokenRouter } from './token'
import { attachCascadeWs } from './ws'

const serverDir = path.dirname(fileURLToPath(import.meta.url))

/** Repo-root `data/` — the default store for the running server. */
const DEFAULT_DATA_DIR = path.resolve(serverDir, '../../data')

/** Built SPA output — the default production static root. */
const DEFAULT_CLIENT_DIST = path.resolve(serverDir, '../../dist/client')

export interface AppDeps {
  /** Backs the REST routers. Defaults to createStorage(<repo>/data). */
  storage?: Storage
  /** Directory the production SPA is served from. Defaults to ../../dist/client. */
  clientDist?: string
}

export function createApp(deps: AppDeps = {}): express.Express {
  const storage = deps.storage ?? createStorage(DEFAULT_DATA_DIR)
  const clientDist = deps.clientDist ?? DEFAULT_CLIENT_DIST

  const app = express()
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })
  app.use(createTokenRouter())
  app.use(createRecordingsRouter({ storage }))
  app.use(createRunsRouter({ storage }))
  // Ticket 023 (QA F6) — blind comparisons over the SAME injected store, so a
  // score submitted on the deployed instance reaches data/ like every other
  // record instead of dying in one browser's localStorage.
  app.use(createBlindComparisonsRouter({ storage }))
  // Ticket 041 — Live sessions over the SAME injected store: every Live take is
  // the stability artifact (PRD §17 19i), and it cannot live in one browser.
  app.use(createLiveSessionsRouter({ storage }))
  // Ticket 034 — post-hoc WER scores, on their own append-only stream.
  app.use(createWerScoresRouter({ storage }))

  // Production: serve the built SPA (PRD §13 — single origin, no CORS).
  // Read at CALL time so the branch is reachable in tests.
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(clientDist))
    app.get(/^\/(?!api\/|ws\/).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')))
  }

  return app
}

/**
 * Build the http server with the cascade WebSocket endpoint attached at
 * /ws/cascade. Tests call this against an ephemeral port; production wiring
 * below uses it for the default listener.
 */
export function createAppServer(deps: AppDeps = {}): http.Server {
  const server = http.createServer(createApp(deps))
  attachCascadeWs(server)
  return server
}

/** The process-wide app. Same wiring as `createApp()` with no overrides. */
const app = createApp()

/**
 * The API's own port. Must stay in agreement with the `/api` and `/ws` proxy
 * targets in vite.config.ts — the client dev server forwards to exactly this.
 */
const DEFAULT_API_PORT = 8787

/**
 * ==================== API PORT RESOLUTION (Ticket 021, normative) ==========
 * Resolve the port the API listens on. Pure — env in, number out — so the
 * decision is testable without spawning a process.
 *
 * PRECEDENCE: `API_PORT` when set, otherwise DEFAULT_API_PORT. The generic
 * port variable (the one tooling exports for whatever it happens to be
 * launching) is DELIBERATELY NEVER CONSULTED.
 *
 * WHY: the repo's own `workbench` preview config declares the *Vite* port
 * 5173, and the harness exports it into the environment shared by both halves
 * of `npm run dev`. The API used to read that generic variable, so it bound
 * 5173 while vite.config.ts still proxied /api and /ws to 8787 — every API
 * call was ECONNREFUSED and the whole Replay/storage half of the app was dead
 * (QA F4). An API-specific name is the only fix that holds no matter who
 * exports the generic one: pinning the port inside `dev:server` would leave
 * `npm start` equally exposed.
 *
 * DEPLOYMENT TRADEOFF (accepted): PaaS platforms that inject a generic port
 * variable and expect the process to bind it (Heroku/Railway/Render/Fly) need
 * `API_PORT` set explicitly. PRD §14 pins deployment to EC2 + Caddy, which
 * reverse-proxies to a fixed port, so nothing here injects one. A future move
 * to such a platform must export API_PORT in the process environment.
 *
 * `createAppServer(deps?)` is a separate concern and reads no environment at
 * all: tests listen(0) on an ephemeral port.
 * ==========================================================================
 */
export function resolveApiPort(env: NodeJS.ProcessEnv = process.env): number {
  const override = env.API_PORT
  if (override === undefined || override.trim() === '') return DEFAULT_API_PORT

  const parsed = Number(override)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : DEFAULT_API_PORT
}

if (process.env.NODE_ENV !== 'test') {
  // Ticket 037. BEFORE anything reads process.env: without this the provider
  // keys are undefined, /api/realtime-token answers 500, and a Live session
  // reaches "connected · listening" before failing opaquely. Skipped under
  // NODE_ENV=test so the suite's environment stays hermetic and no test can
  // accidentally acquire a real key.
  const loaded = loadServerEnv()
  // Ticket 038. A missing provider key used to surface only as an opaque
  // mid-session failure — exactly how 037's `.env` bug stayed invisible. The
  // report decides everything (including its own silence under test); this does
  // nothing but log it, and absence is a warning that never stops the server.
  const keyReport = describeProviderKeys(loaded)
  for (const line of keyReport.lines) {
    if (keyReport.level === 'warn') console.warn(line)
    else console.log(line)
  }
  const port = resolveApiPort()
  createAppServer().listen(port, () => console.log(`server listening on :${port}`))
}

export { app }
