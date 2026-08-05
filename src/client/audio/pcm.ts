/**
 * Ticket 010 — PCM utilities (pure, no DOM/audio deps).
 *
 * ============================ API DESIGN (normative) =======================
 * These signatures/behaviors are locked by pcm.test.ts:
 *
 * - floatTo16(input): Float32 -> Int16. Clamp to [-1, 1] first; +1 -> 32767,
 *   -1 -> -32768, 0 -> 0. Positive values scale by 32767, negative by 32768
 *   (asymmetric, standard PCM mapping) so the round trip through
 *   int16ToFloat32 has error < 1e-4.
 * - int16ToFloat32(input): Int16 -> Float32, divide by 32768.
 * - resampleTo24k(input, fromRate): linear-interpolation resample from
 *   `fromRate` Hz to 24000 Hz. Output length = Math.round(len * 24000/fromRate)
 *   (tests allow ±1). fromRate === 24000 returns a copy with identical
 *   contents. Never produces NaN, even for empty input.
 * - makeChunker(samplesPerFrame = 480): stateful chunker.
 *     push(samples: Int16Array): Int16Array[]  — returns zero or more frames
 *       of EXACTLY samplesPerFrame samples; any remainder is carried and
 *       prepended to the next push (sample order preserved across the seam).
 *     flush(): Int16Array — returns the carried remainder (possibly empty)
 *       and resets the carry.
 * - rms(input: Float32Array | Int16Array): number in 0..1. Int16 input is
 *   normalized by 32768 before the root-mean-square. Empty input -> 0.
 * - rmsToBars(rms): integer 0..5 mic-level bars. Thresholds (locked):
 *     rms <  0.001 -> 0   (silence)
 *     rms <  0.03  -> 1
 *     rms <  0.08  -> 2
 *     rms <  0.15  -> 3
 *     rms <  0.30  -> 4
 *     else         -> 5   (a full-scale sine, rms ~0.707, maxes the meter)
 * - int16ToBase64 / base64ToInt16: base64 of the little-endian PCM16 bytes.
 *   (Local helpers — src/core does not export base64 utilities.) Round-trip
 *   is exact. base64ToInt16 output is alignment-safe (fresh buffer).
 * ==========================================================================
 */

export function floatTo16(_input: Float32Array): Int16Array {
  throw new Error('not implemented');
}

export function int16ToFloat32(_input: Int16Array): Float32Array {
  throw new Error('not implemented');
}

export function resampleTo24k(_input: Float32Array, _fromRate: number): Float32Array {
  throw new Error('not implemented');
}

export interface Chunker {
  /** Returns complete frames of exactly `samplesPerFrame`; carries remainder. */
  push(samples: Int16Array): Int16Array[];
  /** Returns the carried remainder (possibly empty) and resets the carry. */
  flush(): Int16Array;
}

export function makeChunker(_samplesPerFrame = 480): Chunker {
  throw new Error('not implemented');
}

export function rms(_input: Float32Array | Int16Array): number {
  throw new Error('not implemented');
}

export function rmsToBars(_rms: number): number {
  throw new Error('not implemented');
}

export function int16ToBase64(_pcm: Int16Array): string {
  throw new Error('not implemented');
}

export function base64ToInt16(_b64: string): Int16Array {
  throw new Error('not implemented');
}
