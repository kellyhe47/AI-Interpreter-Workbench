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

export function floatTo16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let v = input[i]!;
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}

export function int16ToFloat32(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = input[i]! / 32768;
  }
  return out;
}

export function resampleTo24k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 24000) return new Float32Array(input);
  if (input.length === 0) return new Float32Array(0);
  const outLen = Math.round((input.length * 24000) / fromRate);
  const out = new Float32Array(outLen);
  if (outLen === 0) return out;
  const ratio = fromRate / 24000;
  const last = input.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    if (idx >= last) {
      out[i] = input[last]!;
    } else {
      const frac = pos - idx;
      out[i] = input[idx]! * (1 - frac) + input[idx + 1]! * frac;
    }
  }
  return out;
}

export interface Chunker {
  /** Returns complete frames of exactly `samplesPerFrame`; carries remainder. */
  push(samples: Int16Array): Int16Array[];
  /** Returns the carried remainder (possibly empty) and resets the carry. */
  flush(): Int16Array;
}

export function makeChunker(samplesPerFrame = 480): Chunker {
  let carry = new Int16Array(0);
  return {
    push(samples: Int16Array): Int16Array[] {
      const combined = new Int16Array(carry.length + samples.length);
      combined.set(carry, 0);
      combined.set(samples, carry.length);
      const frames: Int16Array[] = [];
      let offset = 0;
      while (combined.length - offset >= samplesPerFrame) {
        frames.push(combined.slice(offset, offset + samplesPerFrame));
        offset += samplesPerFrame;
      }
      carry = combined.slice(offset);
      return frames;
    },
    flush(): Int16Array {
      const rest = carry;
      carry = new Int16Array(0);
      return rest;
    },
  };
}

export function rms(input: Float32Array | Int16Array): number {
  if (input.length === 0) return 0;
  const isInt16 = input instanceof Int16Array;
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    const v = isInt16 ? input[i]! / 32768 : input[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / input.length);
}

export function rmsToBars(value: number): number {
  if (value < 0.001) return 0;
  if (value < 0.03) return 1;
  if (value < 0.08) return 2;
  if (value < 0.15) return 3;
  if (value < 0.3) return 4;
  return 5;
}

export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
}
