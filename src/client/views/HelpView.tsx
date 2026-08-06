/**
 * Ticket 016 — Help view (STUB, awaiting implementation).
 *
 * Six plain-language cards, copy from the design mock's Help section:
 *   1. What we're researching        — the sealed box vs the assembly line
 *   2. Live vs Replay — the two modes (incl. the three-entity explainer)
 *   3. The three arms                — the derived-tag statement
 *   4. The experiments               — the four questions + the non-pooling rule
 *   5. How to use it                 — the four numbered steps
 *   6. How to read it                — p50/p95, cost slope, provenance, badges
 *
 * Pure: no deps, no state, no clock.
 *
 * DOM contract (locked by HelpView.test.tsx):
 *   [data-help-view] root, containing exactly six [data-help-card] elements,
 *   each with a [data-help-title].
 */

import type { ReactElement } from 'react';

export default function HelpView(): ReactElement | null {
  return null;
}
