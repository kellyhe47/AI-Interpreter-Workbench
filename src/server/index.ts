import express from 'express'
import http from 'node:http'
import { createTokenRouter } from './token'
import { attachCascadeWs } from './ws'

const app = express()
app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})
app.use(createTokenRouter())

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
