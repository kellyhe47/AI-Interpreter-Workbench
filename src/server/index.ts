import express from 'express'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTokenRouter } from './token'
import { attachCascadeWs } from './ws'

const app = express()
app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})
app.use(createTokenRouter())

// Production: serve the built SPA (PRD §13 — single origin, no CORS).
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/client')
  app.use(express.static(clientDist))
  app.get(/^\/(?!api\/|ws\/).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')))
}

/**
 * Build the http server with the cascade WebSocket endpoint attached at
 * /ws/cascade. Tests call this against an ephemeral port; production wiring
 * below uses it for the default listener.
 */
export function createAppServer(): http.Server {
  const server = http.createServer(app)
  attachCascadeWs(server)
  return server
}

const port = Number(process.env.PORT ?? 8787)
if (process.env.NODE_ENV !== 'test') {
  createAppServer().listen(port, () => console.log(`server listening on :${port}`))
}

export { app }
