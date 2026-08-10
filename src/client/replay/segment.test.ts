/**
 * Ticket 035 — segmentTake acceptance tests.
 *
 * Pure function over 24 kHz mono PCM16; every waveform here is synthetic and
 * deterministic. `trueSpeechEndMs` assertions carry a +/- one analysis frame
 * (20 ms) tolerance, because the last sample above the floor sits within half
 * a sine period of the tone's true end.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifest, type CorpusUtterance } from '../../core/corpus';
import { ENDPOINTING_MS } from '../../core/protocol';
import { generateClip } from '../../harness/wav';
import {
  DEFAULT_SEGMENT_OPTIONS,
  SEGMENT_FRAME_MS,
  segmentTake,
  type SegmentedUtterance,
} from './segment';

const RATE = 24_000;
/** One analysis frame; the stated tolerance for every boundary assertion. */
const TOL = SEGMENT_FRAME_MS;

function samplesFor(ms: number): number {
  return Math.round((ms / 1000) * RATE);
}

function tone(ms: number, freq = 440, amp = 0.3): Int16Array {
  const out = new Int16Array(samplesFor(ms));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / RATE));
  }
  return out;
}

function quiet(ms: number): Int16Array {
  return new Int16Array(samplesFor(ms));
}

function concat(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function durationMsOf(samples: Int16Array): number {
  return Math.round((samples.length / RATE) * 1000);
}

/**
 * Three bursts, each surrounded by quiet longer than the ENDPOINTING_MS default:
 *   [300 quiet][800 tone][1200 quiet][600 tone][1400 quiet][500 tone][400 quiet]
 * Ground truth: starts 300/2300/4300, speech ends 1100/2900/4800, total 5200.
 *
 * The inter-burst gaps were 700/900 ms when the pinned control was 500 ms. At
 * 1000 ms they stopped being boundaries and the fixture read as ONE utterance —
 * the same merge that made the operator's real takes unusable, reproduced in
 * miniature. They are widened rather than the threshold being special-cased.
 */
const THREE_BURSTS = concat([
  quiet(300),
  tone(800),
  quiet(1200),
  tone(600),
  quiet(1400),
  tone(500),
  quiet(400),
]);
const THREE_BURST_STARTS = [300, 2300, 4300];
const THREE_BURST_ENDS = [1100, 2900, 4800];

function expectNear(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(TOL);
}

describe('segmentTake defaults', () => {
  it('pins silenceMs to the endpointing control every arm uses', () => {
    expect(DEFAULT_SEGMENT_OPTIONS).toEqual({
      silenceMs: ENDPOINTING_MS,
      floor: 0.01,
      minUtteranceMs: 200,
    });
    expect(SEGMENT_FRAME_MS).toBe(20);
  });
});

describe('segmentTake finds one utterance per burst', () => {
  it('N bursts separated by silence -> N utterances with 1-based contiguous indices', () => {
    const found = segmentTake(THREE_BURSTS);
    expect(found).toHaveLength(3);
    expect(found.map((u) => u.index)).toEqual([1, 2, 3]);
  });

  it('trueSpeechEndMs lands on each burst’s last loud sample (+/- one frame)', () => {
    const found = segmentTake(THREE_BURSTS);
    found.forEach((u, i) => {
      expectNear(u.startMs, THREE_BURST_STARTS[i]!, `utterance ${u.index} startMs`);
      expectNear(u.trueSpeechEndMs, THREE_BURST_ENDS[i]!, `utterance ${u.index} trueSpeechEndMs`);
    });
  });

  it('leading and trailing silence produce no phantom utterance', () => {
    const found = segmentTake(concat([quiet(1000), tone(500), quiet(1000)]));
    expect(found).toHaveLength(1);
    expectNear(found[0]!.startMs, 1000, 'startMs');
    expectNear(found[0]!.trueSpeechEndMs, 1500, 'trueSpeechEndMs');
  });

  it('works on a generateClip waveform (tone burst then silence tail)', () => {
    const clip = generateClip({ durationMs: 2000, speechMs: 1200, freq: 440, rate: RATE });
    const found = segmentTake(clip);
    expect(found).toHaveLength(1);
    expectNear(found[0]!.startMs, 0, 'startMs');
    expectNear(found[0]!.trueSpeechEndMs, 1200, 'trueSpeechEndMs');
  });
});

describe('segmentTake boundary rules', () => {
  it('a gap SHORTER than silenceMs is a mid-sentence pause, not a boundary', () => {
    const wave = concat([tone(600), quiet(300), tone(600), quiet(800)]);
    const found = segmentTake(wave);
    expect(found).toHaveLength(1);
    expectNear(found[0]!.startMs, 0, 'startMs');
    expectNear(found[0]!.trueSpeechEndMs, 1500, 'trueSpeechEndMs');
  });

  it('the same gap DOES split once silenceMs is lowered below it', () => {
    const wave = concat([tone(600), quiet(300), tone(600), quiet(800)]);
    const found = segmentTake(wave, { silenceMs: 200 });
    expect(found).toHaveLength(2);
    expectNear(found[0]!.trueSpeechEndMs, 600, 'first end');
    expectNear(found[1]!.startMs, 900, 'second start');
    expectNear(found[1]!.trueSpeechEndMs, 1500, 'second end');
  });

  it('a burst shorter than minUtteranceMs is dropped as a sliver', () => {
    const wave = concat([tone(60), quiet(800), tone(700), quiet(600)]);
    const found = segmentTake(wave);
    expect(found).toHaveLength(1);
    expect(found[0]!.index).toBe(1);
    expectNear(found[0]!.trueSpeechEndMs, 1560, 'trueSpeechEndMs');
  });

  it('a take of pure silence returns [] rather than one empty utterance', () => {
    expect(segmentTake(quiet(3000))).toEqual([]);
    expect(segmentTake(new Int16Array(0))).toEqual([]);
  });
});

describe('segmentTake output feeds ticket 030’s manifest without drift', () => {
  it('a manifest built from the output passes the real validateManifest', () => {
    const found = segmentTake(THREE_BURSTS);
    const manifest: CorpusUtterance[] = found.map((u: SegmentedUtterance) => ({
      id: `take-1-${u.index}`,
      index: u.index,
      category: 'short-reply',
      trueSpeechEndMs: u.trueSpeechEndMs,
      referenceText: 'placeholder script',
    }));
    expect(validateManifest(manifest, durationMsOf(THREE_BURSTS))).toBeNull();
  });

  it('every trueSpeechEndMs is inside the clip and strictly increasing', () => {
    const found = segmentTake(THREE_BURSTS);
    const duration = durationMsOf(THREE_BURSTS);
    let previous = 0;
    for (const u of found) {
      expect(u.startMs).toBeGreaterThanOrEqual(0);
      expect(u.trueSpeechEndMs).toBeGreaterThan(u.startMs);
      expect(u.trueSpeechEndMs).toBeGreaterThan(previous);
      expect(u.trueSpeechEndMs).toBeLessThanOrEqual(duration);
      previous = u.trueSpeechEndMs;
    }
  });
});

describe('segment.ts stays pure', () => {
  it('uses no DOM and no node-only globals', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/client/replay/segment.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead);
    for (const banned of [
      /\bdocument\b/,
      /\bwindow\b/,
      /\bnavigator\b/,
      /\bprocess\b/,
      /\bBuffer\b/,
      /\brequire\s*\(/,
      /\b__dirname\b/,
      /\bAudioContext\b/,
      /from 'node:/,
      /\bfetch\s*\(/,
    ]) {
      expect(source, `segment.ts must not use ${banned}`).not.toMatch(banned);
    }
  });

  it('is deterministic: the same input yields identical output', () => {
    expect(segmentTake(THREE_BURSTS)).toEqual(segmentTake(THREE_BURSTS));
  });
});
