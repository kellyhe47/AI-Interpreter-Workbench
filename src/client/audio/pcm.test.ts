/**
 * Ticket 010 — pcm.ts acceptance tests (pure functions, no DOM).
 */
import { describe, expect, it } from 'vitest';
import {
  base64ToInt16,
  floatTo16,
  int16ToBase64,
  int16ToFloat32,
  makeChunker,
  resampleTo24k,
  rms,
  rmsToBars,
} from './pcm';

describe('floatTo16 / int16ToFloat32', () => {
  it('maps 0 to 0, +1 to 32767, -1 to -32768', () => {
    const out = floatTo16(new Float32Array([0, 1, -1]));
    expect(out).toBeInstanceOf(Int16Array);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(32767);
    expect(out[2]).toBe(-32768);
  });

  it('clamps out-of-range input to the int16 rails', () => {
    const out = floatTo16(new Float32Array([2.5, -3.1, 1.0001, -1.0001]));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
    expect(out[2]).toBe(32767);
    expect(out[3]).toBe(-32768);
  });

  it('round-trips float -> int16 -> float with error < 1e-4', () => {
    const src = new Float32Array([0, 0.25, -0.25, 0.5, -0.5, 0.9, -0.9, 0.123, -0.987]);
    const back = int16ToFloat32(floatTo16(src));
    expect(back).toBeInstanceOf(Float32Array);
    expect(back.length).toBe(src.length);
    for (let i = 0; i < src.length; i++) {
      expect(Math.abs(back[i]! - src[i]!)).toBeLessThan(1e-4);
    }
  });
});

describe('resampleTo24k', () => {
  it('halves the length (±1) from 48k and produces no NaN', () => {
    const n = 960;
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) src[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    const out = resampleTo24k(src, 48000);
    expect(Math.abs(out.length - n / 2)).toBeLessThanOrEqual(1);
    for (let i = 0; i < out.length; i++) expect(Number.isNaN(out[i])).toBe(false);
  });

  it('applies the 44.1k -> 24k ratio (±1) and interpolates values', () => {
    const n = 441;
    const src = new Float32Array(n).fill(0.5);
    const out = resampleTo24k(src, 44100);
    const expected = (n * 24000) / 44100; // 240
    expect(Math.abs(out.length - expected)).toBeLessThanOrEqual(1);
    for (let i = 0; i < out.length; i++) {
      expect(Number.isNaN(out[i])).toBe(false);
      expect(Math.abs(out[i]! - 0.5)).toBeLessThan(1e-6);
    }
  });

  it('preserves a linear ramp under interpolation', () => {
    const n = 480;
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) src[i] = i / (n - 1);
    const out = resampleTo24k(src, 48000);
    // Midpoint of the ramp should still be ~0.5.
    const mid = out[Math.floor(out.length / 2)]!;
    expect(Math.abs(mid - 0.5)).toBeLessThan(0.02);
    // Monotonic non-decreasing.
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]! - 1e-6);
    }
  });

  it('returns an identical copy when fromRate is already 24000', () => {
    const src = new Float32Array([0.1, -0.2, 0.3]);
    const out = resampleTo24k(src, 24000);
    expect(Array.from(out)).toEqual(Array.from(src));
    expect(out).not.toBe(src); // copy, not the same reference
  });

  it('handles empty input without NaN', () => {
    const out = resampleTo24k(new Float32Array(0), 48000);
    expect(out.length).toBe(0);
  });
});

describe('makeChunker', () => {
  const ramp = (len: number, start = 0): Int16Array => {
    const a = new Int16Array(len);
    for (let i = 0; i < len; i++) a[i] = start + i;
    return a;
  };

  it('emits exact 480-sample frames and carries the remainder', () => {
    const c = makeChunker(480);
    const frames = c.push(ramp(500));
    expect(frames.length).toBe(1);
    expect(frames[0]!.length).toBe(480);
    expect(frames[0]![0]).toBe(0);
    expect(frames[0]![479]).toBe(479);
  });

  it('carries the remainder across pushes, preserving sample order', () => {
    const c = makeChunker(480);
    expect(c.push(ramp(500))).toHaveLength(1); // 20 left over (values 480..499)
    const frames = c.push(ramp(460, 500)); // 20 + 460 = 480
    expect(frames).toHaveLength(1);
    const f = frames[0]!;
    expect(f.length).toBe(480);
    expect(f[0]).toBe(480); // first carried sample
    expect(f[19]).toBe(499); // last carried sample
    expect(f[20]).toBe(500); // first sample of second push
    expect(f[479]).toBe(959);
  });

  it('returns multiple frames from one large push', () => {
    const c = makeChunker(480);
    const frames = c.push(ramp(480 * 3 + 7));
    expect(frames).toHaveLength(3);
    expect(frames[2]![479]).toBe(480 * 3 - 1);
    // remainder of 7 retained
    expect(c.push(ramp(473, 480 * 3 + 7))).toHaveLength(1);
  });

  it('returns no frames while under a full frame', () => {
    const c = makeChunker(480);
    expect(c.push(ramp(100))).toHaveLength(0);
    expect(c.push(ramp(100))).toHaveLength(0);
  });

  it('flush() returns the carried remainder and resets', () => {
    const c = makeChunker(480);
    c.push(ramp(490));
    const rest = c.flush();
    expect(rest.length).toBe(10);
    expect(rest[0]).toBe(480);
    expect(c.flush().length).toBe(0);
  });

  it('defaults samplesPerFrame to 480', () => {
    const c = makeChunker();
    const frames = c.push(ramp(480));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.length).toBe(480);
  });
});

describe('rms / rmsToBars', () => {
  it('rms of silence is 0 (Float32 and Int16)', () => {
    expect(rms(new Float32Array(480))).toBe(0);
    expect(rms(new Int16Array(480))).toBe(0);
  });

  it('rms of a full-scale sine is ~0.707', () => {
    const n = 2400;
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = Math.sin((2 * Math.PI * 100 * i) / 24000);
    const v = rms(f);
    expect(Math.abs(v - Math.SQRT1_2)).toBeLessThan(0.05);
  });

  it('normalizes Int16 input to 0..1', () => {
    const n = 2400;
    const f = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      f[i] = Math.round(32767 * Math.sin((2 * Math.PI * 100 * i) / 24000));
    }
    const v = rms(f);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1);
    expect(Math.abs(v - Math.SQRT1_2)).toBeLessThan(0.05);
  });

  it('maps rms to bars 0..5 at the documented thresholds', () => {
    expect(rmsToBars(0)).toBe(0);
    expect(rmsToBars(0.0005)).toBe(0);
    expect(rmsToBars(0.01)).toBe(1);
    expect(rmsToBars(0.05)).toBe(2);
    expect(rmsToBars(0.1)).toBe(3);
    expect(rmsToBars(0.2)).toBe(4);
    expect(rmsToBars(0.5)).toBe(5);
    expect(rmsToBars(Math.SQRT1_2)).toBe(5); // full-scale sine maxes the meter
  });

  it('rmsToBars always returns an integer in 0..5', () => {
    for (const v of [0, 0.001, 0.02, 0.07, 0.14, 0.29, 0.9, 1]) {
      const bars = rmsToBars(v);
      expect(Number.isInteger(bars)).toBe(true);
      expect(bars).toBeGreaterThanOrEqual(0);
      expect(bars).toBeLessThanOrEqual(5);
    }
  });
});

describe('base64 helpers', () => {
  it('round-trips Int16 PCM exactly', () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768, 12345, -12345]);
    const back = base64ToInt16(int16ToBase64(pcm));
    expect(Array.from(back)).toEqual(Array.from(pcm));
  });

  it('encodes little-endian bytes', () => {
    // 0x0102 little-endian -> bytes [0x02, 0x01] -> base64 "AgE="
    expect(int16ToBase64(new Int16Array([0x0102]))).toBe('AgE=');
    expect(Array.from(base64ToInt16('AgE='))).toEqual([0x0102]);
  });

  it('handles empty input', () => {
    expect(int16ToBase64(new Int16Array(0))).toBe('');
    expect(base64ToInt16('').length).toBe(0);
  });
});
