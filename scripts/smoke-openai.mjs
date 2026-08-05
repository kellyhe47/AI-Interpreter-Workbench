// Manual OpenAI smoke test — makes REAL API calls (not part of vitest).
// Run: npx tsx scripts/smoke-openai.mjs   (needs OPENAI_API_KEY in env)
import { writeFileSync } from 'node:fs';
import { OpenAiMt } from '../src/server/providers/openai-mt.ts';
import { OpenAiTts } from '../src/server/providers/openai-tts.ts';

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY not set');
  process.exit(1);
}

try {
  // MT: one short streamed translation.
  const mt = new OpenAiMt({ targetLang: 'Spanish' });
  let translation = '';
  for await (const chunk of mt.translate('Good morning, how are you today?')) {
    translation += chunk;
  }
  if (!translation.trim()) throw new Error('MT returned an empty translation');
  console.log('MT ok:', JSON.stringify(translation));

  // TTS: one short sentence -> raw PCM16 @24kHz in /tmp.
  const tts = new OpenAiTts({});
  async function* text() {
    yield 'This is a smoke test.';
  }
  const chunks = [];
  for await (const c of tts.synthesize(text())) chunks.push(c);
  const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
  if (totalSamples <= 0) throw new Error('TTS returned no audio');
  const outPath = '/tmp/smoke-openai-tts.pcm';
  writeFileSync(
    outPath,
    Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))),
  );
  console.log(
    `TTS ok: ${totalSamples} samples (${(totalSamples / 24000).toFixed(2)}s @24kHz) -> ${outPath}`,
  );

  console.log(
    'STT: skipped here (needs real speech audio); realtime transcription path was preflight-verified in the 2026-08-04 live spike.',
  );
  console.log('Estimated cost: < $0.002 (~60 gpt-4o-mini tokens + ~21 TTS chars)');
} catch (err) {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
}
