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

export function writeWav(samples: Int16Array, rate: number): Uint8Array {
  void samples;
  void rate;
  throw new Error('not implemented');
}

export function readWav(bytes: Uint8Array): { samples: Int16Array; rate: number } {
  void bytes;
  throw new Error('not implemented');
}

export function generateClip(opts: GenerateClipOptions): Int16Array {
  void opts;
  throw new Error('not implemented');
}
