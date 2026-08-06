/**
 * HTTP + WebSocket entry point.
 *
 * ============================ APP FACTORY SEAM (normative) =================
 *   export interface AppDeps {
 *     storage?: Storage;      // backs /api/recordings + /api/runs
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
 * ROUTE ORDER IS LOAD-BEARING: /api/health, the token route and the two REST
 * routers are all mounted BEFORE the production SPA catch-all, and the
 * catch-all itself excludes /api/ and /ws/ — an SPA that swallowed
 * /api/recordings would answer index.html to every API call in production only.
 */
import express from 'express'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRecordingsRouter, createRunsRouter } from './routes'
import { createStorage } from './storage'
import type { Storage } from './storage'
import { createTokenRouter } from './token'
import { attachCascadeWs } from './ws'

const serverDir = path.dirname(fileURLToPath(import.meta.url))

/** Repo-root `data/` — the default store for the running server. */
const DEFAULT_DATA_DIR = path.resolve(serverDir, '../../data')

/** Built SPA output — the default production static root. */
const DEFAULT_CLIENT_DIST = path.resolve(serverDir, '../../dist/client')

export interface AppDeps {
  /** Backs /api/recordings and /api/runs. Defaults to createStorage(<repo>/data). */
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
 * STUB (Ticket 021) — resolve the port the API listens on from an environment.
 * Pure so it is testable without spawning a process. NOT YET IMPLEMENTED, and
 * the module-level listener below still reads the generic PORT: that is the
 * bug this ticket exists to fix.
 */
export function resolveApiPort(_env: NodeJS.ProcessEnv = process.env): number {
  throw new Error('resolveApiPort not implemented')
}

const port = Number(process.env.PORT ?? 8787)
if (process.env.NODE_ENV !== 'test') {
  createAppServer().listen(port, () => console.log(`server listening on :${port}`))
}

export { app }
