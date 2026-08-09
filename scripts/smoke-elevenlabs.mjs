// Manual ElevenLabs smoke test — makes a REAL WS call (not part of vitest).
// Run: npm run smoke:elevenlabs   (reads ELEVENLABS_API_KEY from .env, like the server)
import { writeFileSync } from 'node:fs';
import { loadServerEnv } from '../src/server/env.ts';
import { ElevenLabsTts } from '../src/server/providers/elevenlabs-tts.ts';

// TICKET 037's FIX APPLIES HERE TOO. This script predates it and read
// `process.env` directly, so it reported "not set" against a .env that had the
// key — the server has loaded it through `loadServerEnv` since 037, and nothing
// else in the repo reads a provider key without going through that call.
// A smoke test that cannot run is not evidence for PRD §13's "one real-provider
// smoke test per path"; it is a claim with a broken script behind it.
loadServerEnv();

if (!process.env.ELEVENLABS_API_KEY) {
  console.error('ELEVENLABS_API_KEY not set — not in the environment and not in .env');
  process.exit(1);
}

try {
  const tts = new ElevenLabsTts({});
  async function* text() {
    yield 'Hello from the ';
    yield 'streaming smoke test.';
  }
  const t0 = Date.now();
  let firstAudioMs = null;
  const chunks = [];
  for await (const c of tts.synthesize(text())) {
    if (firstAudioMs === null) firstAudioMs = Date.now() - t0;
    chunks.push(c);
  }
  const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
  if (totalSamples <= 0) throw new Error('no audio received');
  const outPath = '/tmp/smoke-elevenlabs-tts.pcm';
  writeFileSync(
    outPath,
    Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))),
  );
  console.log(
    `ok: ${totalSamples} samples (${(totalSamples / 24000).toFixed(2)}s @24kHz) -> ${outPath}`,
  );
  console.log(`first-audio latency: ${firstAudioMs}ms`);
  console.log('Estimated cost: ~35 chars on eleven_flash_v2_5 (~18 credits, well under $0.01)');
} catch (err) {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
}
