/**
 * TICKET 052 ROUND 2 — the 051 RESIDUAL on the same screen.
 *
 * THE DEFECT: the four cascade stage bars are proportions of `sum(rows)` —
 * `audio_queued − vad_fired` — while the headline immediately below them reads
 * `tts_first_byte − vad_fired`. **The number the bars decompose is never
 * displayed anywhere.** A reader sees four bars filling one row and a single
 * total under them and reads the former as a decomposition of the latter;
 * nothing on the card says otherwise.
 *
 * WHY IT MATTERS RATHER THAN BEING A DETAIL. `deliver` is DELIBERATELY outside
 * the headline: it is the tail of synthesis after the first audio byte, and it
 * grows without bound with sentence length. On real stored data
 * (`session-1786215745428`, utterance 1) it takes 13.8% of the bar row while
 * contributing 0% of the headline. So the widest visual claim on the card is
 * made by the one row that is not in the number the card reports — R2-1's
 * confound arriving as pixels instead of digits.
 *
 * THE DECISION: the bars decompose the HEADLINE. `transcribe` / `translate` /
 * `synthesize` are proportions of `tts_first_byte − vad_fired` and sum to it;
 * `deliver` keeps its figure and its span text — it is real information — and
 * renders with no bar, or a muted one, matching its outside-the-headline
 * status.
 *
 * The marks below are `LiveView.timings.test.tsx`'s, chosen so `deliver` is
 * enormous (2760 ms against a 1240 ms headline): any implementation that still
 * divides by the row sum fails LOUDLY here rather than by a rounding step.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FixtureScriptEvent } from '../transport/fixture';
import {
  SRC_FINAL,
  TGT_FINAL,
  advance,
  audioChunk,
  clickStartMicrophone,
  makeRecord,
  renderApp,
  stageRow,
  targetCard,
  text,
} from './sessionTestKit';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 *   transcribe   810 −  500 =  310 ms
 *   translate   1030 −  810 =  220 ms
 *   synthesize  1740 − 1030 =  710 ms   <- ends at the FIRST synthesized byte
 *   deliver     4500 − 1740 = 2760 ms   <- real, and OUTSIDE the headline
 *   HEADLINE    1740 −  500 = 1240 ms
 *   row sum                  = 4000 ms  <- what the bars divide by today
 */
const MARKS = {
  vad_fired: 500,
  stt_final: 810,
  mt_first_token: 1_030,
  tts_first_byte: 1_740,
  audio_queued: 4_500,
};

const HEADLINE_MS = MARKS.tts_first_byte - MARKS.vad_fired;
const HEADLINE_STAGES = ['transcribe', 'translate', 'synthesize'] as const;
const STAGE_MS: Record<string, number> = {
  transcribe: MARKS.stt_final - MARKS.vad_fired,
  translate: MARKS.mt_first_token - MARKS.stt_final,
  synthesize: MARKS.tts_first_byte - MARKS.mt_first_token,
};

/** One cascade utterance as the real server delivers it: marks on the record. */
function cascadeScript(): FixtureScriptEvent[] {
  return [
    { at: 20, type: 'sourceText', kind: 'final', text: SRC_FINAL, utt: 0 },
    { at: 30, type: 'targetText', kind: 'final', text: TGT_FINAL, utt: 0 },
    { at: 40, type: 'audio', pcm: audioChunk(), utt: 0 },
    {
      at: 60,
      type: 'utteranceComplete',
      record: makeRecord({ id: 'utt-0', timings: MARKS, costUnits: null as unknown as number }),
    },
  ];
}

async function renderOneUtterance(): Promise<void> {
  // Live defaults to Realtime; the four-stage card is cascade's.
  renderApp({ initialState: { mode: 'cascade' }, scripts: { cascade: cascadeScript() } });
  await clickStartMicrophone();
  await advance(200);
}

/** The fill percentage of one stage row's bar; 0 when it has no bar at all. */
function barPct(label: string): number {
  const row = stageRow(targetCard(), label);
  if (row === null) throw new Error(`missing stage row: ${label}`);
  const fill = row.querySelector('[data-stage-bar] > *') as HTMLElement | null;
  if (fill === null) return 0;
  const width = fill.style.width;
  return width === '' ? 0 : Number.parseFloat(width);
}

describe('the Live stage bars decompose the HEADLINE they sit under', () => {
  it('renders all four rows — deliver keeps its figure', async () => {
    await renderOneUtterance();
    for (const label of [...HEADLINE_STAGES, 'deliver']) {
      expect(stageRow(targetCard(), label), label).not.toBeNull();
    }
    expect(text(stageRow(targetCard(), 'deliver')!)).toContain('2.76 s');
  });

  it('gives the three headline stages proportions of the HEADLINE, summing to 100%', async () => {
    await renderOneUtterance();
    const pcts = HEADLINE_STAGES.map(barPct);
    // Dividing by the row sum (4000 ms) gives 8/6/18 and never reaches 100.
    expect(pcts.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
    for (const stage of HEADLINE_STAGES) {
      expect(barPct(stage), stage).toBeCloseTo((STAGE_MS[stage]! / HEADLINE_MS) * 100, 0);
    }
  });

  it('gives `deliver` NO share of the bar row — it is outside the number shown', async () => {
    await renderOneUtterance();
    // Today this is the WIDEST bar on the card (2760 of 4000 ms) while
    // contributing nothing to the total printed beneath it.
    expect(barPct('deliver')).toBe(0);
  });

  it('states the total the bars add up to', async () => {
    await renderOneUtterance();
    const total = document.querySelector('[data-live-total]');
    expect(total).not.toBeNull();
    // The headline, not the row sum: 1.24 s, never 4.00 s.
    expect(text(total)).toContain('1.24 s');
    expect(text(total)).not.toContain('4.00 s');
  });
});
