import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../core/protocol';
import { generateClip, readWav, writeWav } from './wav';

const FS = 32767;

function ascii(bytes: Uint8Array, start: number, len: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + len));
}

describe('writeWav', () => {
  it('emits a canonical 44-byte RIFF/WAVE mono PCM16 header', () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const bytes = writeWav(samples, SAMPLE_RATE);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(bytes.byteLength).toBe(44 + samples.length * 2);
    expect(ascii(bytes, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(ascii(bytes, 8, 4)).toBe('WAVE');

    expect(ascii(bytes, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // audioFormat: PCM
    expect(view.getUint16(22, true)).toBe(1); // channels: mono
    expect(view.getUint32(24, true)).toBe(24000); // sample rate
    expect(view.getUint32(28, true)).toBe(24000 * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample

    expect(ascii(bytes, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it('stores samples little-endian in the data chunk', () => {
    const bytes = writeWav(new Int16Array([0x1234]), SAMPLE_RATE);
    expect(bytes[44]).toBe(0x34);
    expect(bytes[45]).toBe(0x12);
  });
});

describe('writeWav -> readWav round trip', () => {
  it('preserves rate, sample count, and exact sample values', () => {
    const samples = new Int16Array(1000);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = ((i * 7919) % 65536) - 32768;
    }
    const { samples: out, rate } = readWav(writeWav(samples, SAMPLE_RATE));
    expect(rate).toBe(SAMPLE_RATE);
    expect(out.length).toBe(samples.length);
    expect(Array.from(out)).toEqual(Array.from(samples));
  });

  it('round-trips a non-default rate', () => {
    const samples = new Int16Array([5, -5, 10, -10]);
    const { samples: out, rate } = readWav(writeWav(samples, 16000));
    expect(rate).toBe(16000);
    expect(Array.from(out)).toEqual([5, -5, 10, -10]);
  });
});

describe('readWav validation', () => {
  const valid = () => writeWav(new Int16Array([1, 2, 3, 4]), SAMPLE_RATE);

  it('throws on bad RIFF magic', () => {
    const bytes = valid();
    bytes[0] = 0x58; // 'X'
    expect(() => readWav(bytes)).toThrow();
  });

  it('throws on bad WAVE magic', () => {
    const bytes = valid();
    bytes[8] = 0x58;
    expect(() => readWav(bytes)).toThrow();
  });

  it('throws on non-PCM audio format', () => {
    const bytes = valid();
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(20, 3, true); // float
    expect(() => readWav(bytes)).toThrow();
  });

  it('throws on stereo (channels !== 1)', () => {
    const bytes = valid();
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(22, 2, true);
    expect(() => readWav(bytes)).toThrow();
  });

  it('throws on bits per sample !== 16', () => {
    const bytes = valid();
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(34, 8, true);
    expect(() => readWav(bytes)).toThrow();
  });

  it('throws a real validation error on garbage bytes', () => {
    let err: unknown;
    try {
      readWav(new Uint8Array([1, 2, 3]));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    // Must be a genuine validation error, not the unimplemented stub.
    expect((err as Error).message).not.toBe('not implemented');
  });
});

describe('generateClip', () => {
  const opts = { durationMs: 500, speechMs: 300, freq: 440, rate: SAMPLE_RATE };

  it('produces durationMs * 24 samples at 24 kHz', () => {
    expect(generateClip(opts).length).toBe(500 * 24);
    expect(generateClip({ ...opts, durationMs: 400, speechMs: 200 }).length).toBe(400 * 24);
  });

  it('has tone (nonzero samples) before speechMs', () => {
    const clip = generateClip(opts);
    const speech = clip.subarray(0, 300 * 24);
    let nonzero = 0;
    let maxAbs = 0;
    for (let i = 0; i < speech.length; i++) {
      const v = Math.abs(speech[i]!);
      if (v > 0) nonzero++;
      if (v > maxAbs) maxAbs = v;
    }
    // A sine crosses zero, but the burst must be overwhelmingly nonzero…
    expect(nonzero).toBeGreaterThan(speech.length * 0.9);
    // …and actually audible: peak near the ~0.3 FS design amplitude.
    expect(maxAbs).toBeGreaterThan(0.2 * FS);
  });

  it('is pure digital silence after speechMs (the ground-truth tail)', () => {
    const clip = generateClip(opts);
    const tail = clip.subarray(300 * 24);
    expect(tail.length).toBe(200 * 24);
    expect(tail.every((v) => v === 0)).toBe(true);
  });

  it('keeps amplitude at or below ~0.35 full-scale', () => {
    const clip = generateClip(opts);
    let maxAbs = 0;
    for (let i = 0; i < clip.length; i++) {
      const v = Math.abs(clip[i]!);
      if (v > maxAbs) maxAbs = v;
    }
    expect(maxAbs).toBeLessThanOrEqual(Math.ceil(0.35 * FS));
  });
});
