import express from 'express'

const app = express()
app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

const port = Number(process.env.PORT ?? 8787)
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => console.log(`server listening on :${port}`))
}

export { app }
