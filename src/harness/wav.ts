/**
 * Ticket 015 — WAV encode/decode + synthetic clip generation for the
 * benchmark harness.
 *
 * ============================ API DESIGN (normative) =======================
 * All audio is 24 kHz mono PCM16 (src/core/protocol.ts SAMPLE_RATE) unless a
 * different `rate` is passed explicitly.
 *
 * writeWav(samples, rate) -> Uint8Array
 *   Minimal canonical RIFF/WAVE container: 'RIFF' + size, 'WAVE', a 16-byte
 *   'fmt ' chunk (audioFormat=1 PCM, channels=1, sampleRate=rate,
 *   byteRate=rate*2, blockAlign=2, bitsPerSample=16), then one 'data' chunk
 *   holding the little-endian Int16 samples. Exactly 44 header bytes +
 *   samples.length*2 data bytes. RIFF size field = 36 + dataBytes.
 *
 * readWav(bytes) -> { samples: Int16Array; rate: number }
 *   Parses a WAV produced by writeWav (or any compatible mono PCM16 WAV).
 *   VALIDATES and throws Error on: missing 'RIFF'/'WAVE' magic, missing
 *   'fmt ' chunk, audioFormat !== 1 (PCM), channels !== 1 (mono),
 *   bitsPerSample !== 16, or missing 'data' chunk. Returned samples are a
 *   copy (alignment-safe for any byteOffset of the input view).
 *
 * generateClip({ durationMs, speechMs, freq, rate }) -> Int16Array
 *   SYNTHETIC placeholder clip: a sine tone burst at `freq` Hz with
 *   amplitude ~0.3 full-scale (0.3 * 32767) for the first `speechMs`
 *   milliseconds, followed by pure digital silence (all-zero samples) to
 *   `durationMs`. Total length = round(durationMs/1000 * rate) samples.
 *   The tone->silence boundary at `speechMs` is the clip's GROUND-TRUTH
 *   speech end — the corpus manifest's speechEndMs refers to exactly this
 *   boundary. speechMs must be < durationMs (silence tail always present).
 * ==========================================================================
 */

export interface GenerateClipOptions {
  /** Total clip length in milliseconds (tone + silence tail). */
  durationMs: number;
  /** Tone-burst length in milliseconds; the ground-truth speech end. */
  speechMs: number;
  /** Sine frequency in Hz. */
  freq: number;
  /** Sample rate in Hz (use SAMPLE_RATE = 24000 for corpus clips). */
  rate: number;
}

const HEADER_BYTES = 44;

function ascii(bytes: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

export function writeWav(samples: Int16Array, rate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(out.buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');

  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // audioFormat: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byteRate
  view.setUint16(32, 2, true); // blockAlign
  view.setUint16(34, 16, true); // bitsPerSample

  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(HEADER_BYTES + i * 2, samples[i]!, true);
  }
  return out;
}

export function readWav(bytes: Uint8Array): { samples: Int16Array; rate: number } {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new Error(`WAV too short: ${bytes.byteLength} bytes (need >= ${HEADER_BYTES})`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (ascii(bytes, 0, 4) !== 'RIFF') throw new Error("missing 'RIFF' magic");
  if (ascii(bytes, 8, 4) !== 'WAVE') throw new Error("missing 'WAVE' magic");

  // Walk chunks after the RIFF/WAVE preamble.
  let fmt: { audioFormat: number; channels: number; rate: number; bits: number } | undefined;
  let data: { offset: number; length: number } | undefined;
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = ascii(bytes, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (body + 16 > bytes.byteLength) throw new Error("truncated 'fmt ' chunk");
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (body + size > bytes.byteLength) throw new Error("truncated 'data' chunk");
      data = { offset: body, length: size };
    }
    pos = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt) throw new Error("missing 'fmt ' chunk");
  if (fmt.audioFormat !== 1) throw new Error(`unsupported audio format ${fmt.audioFormat} (need PCM=1)`);
  if (fmt.channels !== 1) throw new Error(`unsupported channel count ${fmt.channels} (need mono)`);
  if (fmt.bits !== 16) throw new Error(`unsupported bits per sample ${fmt.bits} (need 16)`);
  if (!data) throw new Error("missing 'data' chunk");
  if (data.length % 2 !== 0) throw new Error(`data chunk must be whole Int16 samples, got ${data.length} bytes`);

  // Copy out (alignment-safe for any byteOffset of the input view).
  const samples = new Int16Array(data.length / 2);
  new Uint8Array(samples.buffer).set(
    bytes.subarray(data.offset, data.offset + data.length),
  );
  return { samples, rate: fmt.rate };
}

export function generateClip(opts: GenerateClipOptions): Int16Array {
  const { durationMs, speechMs, freq, rate } = opts;
  if (speechMs >= durationMs) {
    throw new Error(`speechMs (${speechMs}) must be < durationMs (${durationMs})`);
  }
  const total = Math.round((durationMs / 1000) * rate);
  const speechSamples = Math.round((speechMs / 1000) * rate);
  const amplitude = 0.3 * 32767;
  const clip = new Int16Array(total); // silence tail stays all-zero
  for (let i = 0; i < speechSamples && i < total; i++) {
    clip[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / rate));
  }
  return clip;
}
