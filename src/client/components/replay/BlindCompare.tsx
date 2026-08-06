/**
 * Ticket 014 — Blind compare, re-homed from Live into Replay (PRD §10,
 * §17 16b · 25d).
 *
 * MOVED, NOT COPIED: `src/client/components/session/BlindCompare.tsx` is
 * deleted. Live is one architecture per session, so there was never anything
 * to compare there; Replay never autoplays, which is precisely what makes
 * deliberate A/B listening — and therefore blind scoring — possible at all.
 *
 * ============================== DOM CONTRACT ==============================
 * Root [data-blind-card].
 *
 * PAIRWISE ONLY. Ranking three samples at once is not something a human can
 * judge, so the unit is a PAIR:
 *   - exactly 2 completed Runs → they ARE the pair; no picker is rendered
 *   - 3 or more               → [data-blind-pair-picker] with one
 *     [data-blind-pick][data-run=<id>] per Run, aria-pressed on the two
 *     chosen. Only Runs of the SAME Recording appear — a run of another
 *     Recording is not a comparison, it is a different input.
 *
 * The picker names Runs NEUTRALLY ('Run 1', 'Run 2', …). Labelling them by
 * configuration would defeat the blinding before it started.
 *
 * PLAYBACK ONLY. Per sample [data-blind-sample='A'|'B']:
 *   - title 'Sample A' / 'Sample B'
 *   - a play control named 'play' → onPlay(<the run behind that sample>)
 *   - [data-blind-dimension='adequacy'|'fluency'], each with five buttons
 *     '1'…'5' carrying aria-pressed
 * PRE-SUBMIT the component renders NEITHER run's configuration identity NOR
 * its transcript — absent from the DOM, not hidden with CSS. Showing the text
 * would let the wrong-language-pronunciation class of error pass unnoticed: a
 * TTS that reads Cantonese text aloud in Mandarin produces a transcript that
 * reads correctly and audio that is wrong (PRD §11).
 *
 * THE DRAW IS INJECTED AND PER COMPARISON. One `rng()` value per comparison:
 * < 0.5 keeps the picked order, >= 0.5 swaps it. A fixed A↔B inversion would
 * teach the evaluator the mapping after a single reveal.
 *
 * SUBMIT persists the whole thing — the two run ids, THE DRAWN ASSIGNMENT,
 * both dimensions for both samples, and the evaluator's language — and only
 * then reveals identity, from the persisted draw rather than recomputed.
 * Submit is unavailable until all four scores are in.
 * ==========================================================================
 */

import type { ReactElement } from 'react';
import type { BlindComparison, Recording, Run } from '../../state/ledger';

export type { BlindComparison };

export interface BlindCompareProps {
  /** The Recording under comparison. Both Runs must be Runs of it. */
  recording: Recording;
  /** Its COMPLETED Runs, and nothing else — the only pairable candidates. */
  runs: Run[];
  /** The injected randomness source. NEVER `Math.random` captured directly. */
  rng: () => number;
  /** The language the evaluator judges in; persisted with the draw. */
  evaluatorLanguage: string;
  now: () => number;
  newId: () => string;
  /** On-demand playback of the Run behind a sample. Never called at render. */
  onPlay: (runId: string) => void;
  /** Appends the completed comparison to the ledger. */
  onSubmit: (comparison: BlindComparison) => void;
}

export default function BlindCompare(_props: BlindCompareProps): ReactElement | null {
  // Ticket 014 — stub. The behaviour is specified by BlindCompare.test.tsx.
  return null;
}
