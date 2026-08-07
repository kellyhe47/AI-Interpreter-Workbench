/**
 * Ticket 042, last mile — the WER hydration seam must actually be SUPPLIED.
 *
 * `hydrateLedger` accepts an optional `werScores` listing and ticket 034 tested
 * it thoroughly. But NOTHING supplied it: `browserDeps` built no client for it
 * and `App`'s observer wrapper did not forward it. The scores were written to
 * `wer-scores.jsonl`, served by `GET /api/wer-scores`, and never fetched — so
 * every WER cell read `not yet measured` while 121 real scores sat on disk.
 *
 * This is the same trap ticket 041 hit with `liveSessions`: App rebuilds the
 * hydration source in a `useMemo`, so a key it forgets is a key hydration never
 * sees. Both halves are pinned here — the shipped bag must CARRY the seam, and
 * App must FORWARD it.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App, { type AppDeps } from '../App';
import { buildBrowserDeps } from '../browserDeps';
import type { LedgerHydrationSource } from '../state/hydrateLedger';
import { makeDeps } from './sessionTestKit';

afterEach(cleanup);

function panel(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-results-tab]');
  if (!found) throw new Error('missing results panel');
  return found;
}

function showResults(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Results' }));
}

describe('ticket 042 — the werScores hydration seam is supplied end to end', () => {
  it('the SHIPPED bag carries a werScores listing', () => {
    // Without this the real app fetches recordings and runs but never the
    // scores, and every WER cell reads "not yet measured" over a full store.
    expect(typeof buildBrowserDeps().hydrate.werScores?.list).toBe('function');
  });

  it('App FORWARDS the werScores listing through its observer wrapper', async () => {
    // App rebuilds the source in a useMemo. A wrapper that forgets the key
    // drops the seam silently: hydrateLedger sees a source with no `werScores`
    // and treats this host as having no score backend at all.
    const kit = makeDeps({ now: () => 0 });
    const listWerScores = vi.fn().mockResolvedValue([]);
    const source: LedgerHydrationSource = {
      recordings: { list: vi.fn().mockResolvedValue([]) },
      runs: { list: vi.fn().mockResolvedValue([]) },
      werScores: { list: listWerScores },
    };
    const deps: AppDeps = { ...kit.deps, hydrate: source };

    render(<App deps={deps} />);
    showResults();

    await waitFor(() => expect(listWerScores).toHaveBeenCalled());
  });

  it('REGRESSION GUARD: a host WITHOUT the seam still hydrates', async () => {
    // Every pre-042 bag must keep working. Synthesising the key here would make
    // such a host claim a score backend it does not have.
    const kit = makeDeps({ now: () => 0 });
    const source: LedgerHydrationSource = {
      recordings: { list: vi.fn().mockResolvedValue([]) },
      runs: { list: vi.fn().mockResolvedValue([]) },
    };

    render(<App deps={{ ...kit.deps, hydrate: source }} />);
    showResults();

    await waitFor(() => expect(panel().getAttribute('data-results-hydration')).toBe('ready'));
  });
});
