/**
 * Ticket 016 — Help view: six plain-language cards.
 *
 * The point of this view is that a reader who has never seen the PRD can tell
 * what is being measured and what the numbers mean. Three sentences carry
 * rules the rest of the app enforces silently, so they are pinned verbatim:
 *
 *  1. THE THREE ENTITIES. A Recording is an input, a Run is one execution of a
 *     Recording through one configuration, a LiveSession is a real
 *     conversation's metrics — and LiveSessions and Runs are never compared,
 *     because they have different inputs and no shared basis.
 *  2. THE TAG IS DERIVED. 'You never label a run yourself' — nothing anywhere
 *     in the app sets an arm tag, so the Help text must not imply otherwise.
 *  3. NOTHING POOLS. A Cantonese finding is never evidence about Spanish
 *     speed; the result screens keep the tracks apart and Help says why.
 *
 * Layout and colour are NOT asserted — only that the styling comes from
 * tokens (source guard at the bottom).
 */

// Imported directly (in addition to vitest.setup.ts) so the jest-dom matcher
// type augmentation is visible to `tsc -p tsconfig.json`.
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import HelpView from './HelpView';

afterEach(cleanup);

/* =============================================================== helpers == */

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

function get(selector: string): HTMLElement {
  const found = q(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}

const all = (selector: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(selector));

/** Collapses whitespace so a copy assertion is not JSX-node-shaped. */
const text = (element: Element | null): string =>
  (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

const cards = (): HTMLElement[] => all('[data-help-card]');

/** The card whose title is `title`. Throws if it is missing. */
function card(title: string): HTMLElement {
  const found = cards().find((c) => text(c.querySelector('[data-help-title]')) === title);
  if (!found) {
    throw new Error(
      `no help card titled ${JSON.stringify(title)}; found: ` +
        JSON.stringify(cards().map((c) => text(c.querySelector('[data-help-title]')))),
    );
  }
  return found;
}

/* ================================================================== copy == */

/** The six card titles, in the order the mock lays them out. */
const TITLES = [
  "What we're researching",
  'Live vs Replay — the two modes',
  'The three arms',
  'The experiments',
  'How to use it',
  'How to read it',
] as const;

/** Card 2's box — the three entities and the rule that keeps them apart. */
const THREE_ENTITIES =
  'Three things to keep straight: a Recording is an input (what was said), a ' +
  'Run is one execution of a Recording through one configuration, and a ' +
  "LiveSession is a real conversation's metrics. Live sessions and Runs are " +
  'never compared — different inputs, no shared basis.';

/** Card 3 — membership is derived, never declared. */
const DERIVED_TAG =
  'You never label a run yourself — the app derives the tag from what you actually configured.';

/** Card 4's closing box — the non-pooling rule. */
const NON_POOLING =
  'These tracks are never mixed: a Cantonese finding is never evidence about Spanish speed.';

/* ================================================================= tests == */

describe('HelpView — six plain-language cards', () => {
  it('renders the view and exactly six cards, titled in mock order', () => {
    render(<HelpView />);

    expect(q('[data-help-view]')).not.toBeNull();
    expect(cards()).toHaveLength(6);
    expect(cards().map((c) => text(c.querySelector('[data-help-title]')))).toEqual([...TITLES]);
  });

  it('card 1 frames the question as the sealed box vs the assembly line', () => {
    render(<HelpView />);
    const body = text(card("What we're researching"));
    expect(body).toContain('sealed box');
    expect(body).toContain('assembly line');
  });

  it('card 2 spells out the three entities — and that LiveSessions and Runs never compare', () => {
    render(<HelpView />);
    expect(text(card('Live vs Replay — the two modes'))).toContain(THREE_ENTITIES);
  });

  it('card 3 states that the arm tag is DERIVED, never labelled by hand', () => {
    render(<HelpView />);
    expect(text(card('The three arms'))).toContain(DERIVED_TAG);
  });

  it('card 4 names the four questions and closes on the non-pooling rule', () => {
    render(<HelpView />);
    const body = text(card('The experiments'));
    expect(body).toContain('Does the design itself cost speed?');
    expect(body).toContain('What does swapping one part buy?');
    expect(body).toContain('What happens over a long conversation?');
    expect(body).toContain('What about a less common language?');
    expect(body).toContain(NON_POOLING);
  });

  it('card 5 gives four numbered steps: Live → Replay → Run/Batch → Compare blind', () => {
    render(<HelpView />);
    const body = text(card('How to use it'));
    for (const step of ['1.', '2.', '3.', '4.']) expect(body).toContain(step);
    expect(body).toContain('Start microphone');
    expect(body).toContain('Batch sweep');
    expect(body).toContain('Compare blind');
  });

  it('card 6 explains p50/p95, the cost slope, provenance lines and the illustrative badges', () => {
    render(<HelpView />);
    const body = text(card('How to read it'));
    expect(body).toContain('p50 / p95');
    expect(body).toContain('Cost per minute');
    expect(body).toContain('Provenance lines');
    expect(body).toContain('Illustrative');
    // A number without a provenance line is just a claim.
    expect(body).toContain('A number without that line is just a claim.');
  });

  it('is pure — it renders with no props, no clock and no deps', () => {
    // Rendering twice must produce identical text: nothing here is stateful.
    render(<HelpView />);
    const first = text(get('[data-help-view]'));
    expect(first.length).toBeGreaterThan(500);
    cleanup();
    render(<HelpView />);
    expect(text(get('[data-help-view]'))).toBe(first);
    // Help explains; it does not act. No controls, no clock, no deps.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

/* ============================================== source-level guarantees ==== */

describe('HelpView.tsx source — tokens only', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/client/views/HelpView.tsx'), 'utf8');

  it('styles from tokens only — no hex, rgb or oklch literal', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
    expect(source).not.toMatch(/\boklch\(/);
  });
});
