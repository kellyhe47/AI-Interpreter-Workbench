// Manual ElevenLabs smoke test — makes a REAL WS call (not part of vitest).
// Run: npx tsx scripts/smoke-elevenlabs.mjs   (needs ELEVENLABS_API_KEY in env)
import { writeFileSync } from 'node:fs';
import { ElevenLabsTts } from '../src/server/providers/elevenlabs-tts.ts';

if (!process.env.ELEVENLABS_API_KEY) {
  console.error('ELEVENLABS_API_KEY not set');
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
