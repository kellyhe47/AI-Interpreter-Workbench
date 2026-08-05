// Fixture stability soak (PRD §7 stability / §14 Day 6, fixture variant).
// Loops placeholder corpus clips through the real server + cascade orchestrator with fixture
// providers over a real WebSocket for --minutes, sampling heap every 60s.
// PLACEHOLDER data only — leak/stability signal, never a reported latency number.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

process.env.NODE_ENV = 'test'
const { createAppServer } = await import('../src/server/index.ts')
const { runFixtureBench } = await import('../src/harness/bench.ts')
const { readWav } = await import('../src/harness/wav.ts')

const minutes = Number(process.argv[2] ?? 30)
const manifest = JSON.parse(readFileSync('corpus/manifest.json', 'utf8'))
const clips = manifest.clips.slice(0, 6).map((c) => ({
  ...c,
  samples: readWav(new Uint8Array(readFileSync(path.join('corpus', c.file)))).samples,
}))

const server = createAppServer()
await new Promise((r) => server.listen(0, r))
const t0 = Date.now()
const heap = []
const errors = []
let utterances = 0
const sample = () => {
  global.gc?.()
  heap.push({ tMin: +((Date.now() - t0) / 60000).toFixed(1), heapUsedMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1) })
}
sample()
const hs = setInterval(sample, 60_000)
while (Date.now() - t0 < minutes * 60_000) {
  try {
    const records = await runFixtureBench({
      server, clips, corpusId: manifest.corpusId,
      providers: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
    })
    utterances += records.length
  } catch (e) {
    errors.push({ tMin: +((Date.now() - t0) / 60000).toFixed(1), message: String(e).slice(0, 200) })
    if (errors.length > 20) break
  }
}
clearInterval(hs)
sample()
server.close()
const out = {
  PLACEHOLDER: true, kind: 'fixture-soak', minutes, utterances, errors,
  heapSamples: heap, heapStartMB: heap[0].heapUsedMB, heapEndMB: heap[heap.length - 1].heapUsedMB,
}
writeFileSync('benchmark-results/fixture-soak.json', JSON.stringify(out, null, 2))
console.log(JSON.stringify(out))
process.exit(errors.length > 20 ? 1 : 0)
