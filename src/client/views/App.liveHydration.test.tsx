/**
 * TICKET 041 — the Live-session seams reach the real product.
 *
 * Two failure modes this suite exists for, both invisible to the unit tests
 * that pin `hydrateLedger` and the controller directly:
 *
 *  1. App REBUILDS the hydration source (it wraps each listing to observe when
 *     the load settles). A wrapper that copies only `recordings` and `runs`
 *     silently drops the live-session listing, and Results stays Live-empty
 *     after a reload no matter how correct hydrateLedger is.
 *  2. `buildBrowserDeps` is the only place the production app is wired. A seam
 *     nothing wires is a seam that does not exist — which is exactly how the
 *     sessions ended up browser-local in the first place.
 *
 * ADDITIVE to the locked App.test.tsx and App.hydration.test.tsx: nothing here
 * changes what a bag WITHOUT the new field does.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App, { type AppDeps } from '../App';
import { buildBrowserDeps } from '../browserDeps';
import {
  EMPTY_LIVE_SESSION,
  LIVE_SESSION_IDS,
  SERVER_LIVE_SESSIONS,
  SERVER_RECORDINGS,
  SERVER_RUNS,
  staticHydrationSource,
} from '../state/hydrationFixtures';
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

const ALL_SESSIONS = [...SERVER_LIVE_SESSIONS, EMPTY_LIVE_SESSION];

describe('ticket 041 — App forwards the live-session listing to Results', () => {
  it('AC2: the server’s LiveSessions land in the SHARED ledger', async () => {
    const kit = makeDeps({ now: () => 0 });
    const { source } = staticHydrationSource(SERVER_RECORDINGS, SERVER_RUNS, ALL_SESSIONS);
    const deps: AppDeps = { ...kit.deps, hydrate: source };
    render(<App deps={deps} />);

    showResults();
    await waitFor(() => expect(panel().getAttribute('data-results-hydration')).toBe('ready'));

    expect(kit.ledger.getLiveSessions().map((s) => s.id)).toEqual(ALL_SESSIONS.map((s) => s.id));
  });

  it('AC2: the conversation-length card renders the hydrated Live metrics', async () => {
    const kit = makeDeps({ now: () => 0 });
    render(
      <App
        deps={{
          ...kit.deps,
          hydrate: staticHydrationSource(SERVER_RECORDINGS, SERVER_RUNS, ALL_SESSIONS).source,
        }}
      />,
    );

    showResults();
    await waitFor(() => expect(panel().getAttribute('data-results-hydration')).toBe('ready'));

    // The card exists and is NOT in its empty state: a reload no longer loses
    // the stability artifact.
    const liveCard = document.querySelector('[data-card="live"]');
    expect(liveCard).not.toBeNull();
    expect(liveCard!.querySelector('[data-empty-card="live"]')).toBeNull();
  });

  it('AC5: the hydrated ZERO-UTTERANCE session is present but adds no column', async () => {
    const kit = makeDeps({ now: () => 0 });
    render(
      <App
        deps={{
          ...kit.deps,
          hydrate: staticHydrationSource(SERVER_RECORDINGS, SERVER_RUNS, [EMPTY_LIVE_SESSION])
            .source,
        }}
      />,
    );

    showResults();
    await waitFor(() => expect(panel().getAttribute('data-results-hydration')).toBe('ready'));

    expect(kit.ledger.getLiveSessions().map((s) => s.id)).toEqual([LIVE_SESSION_IDS.empty]);
    // Stored, listed — and behind no figure at all.
    expect(document.querySelector('[data-card="live"] [data-empty-card="live"]')).not.toBeNull();
  });

  it('a hydrate source with no live listing leaves the LiveSession store alone', async () => {
    const kit = makeDeps({ now: () => 0 });
    render(<App deps={{ ...kit.deps, hydrate: staticHydrationSource().source }} />);

    showResults();
    await waitFor(() => expect(panel().getAttribute('data-results-hydration')).toBe('ready'));

    expect(kit.ledger.getLiveSessions()).toEqual([]);
    expect(kit.ledger.getRuns().map((r) => r.id)).toEqual(SERVER_RUNS.map((r) => r.id));
  });
});

describe('ticket 041 — production wiring: buildBrowserDeps supplies both seams', () => {
  it('AC1/AC2: the write seam and the hydration listing are both present', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const deps = buildBrowserDeps();

      // The WRITE seam: where a finished session is POSTed.
      expect(typeof deps.liveSessions?.create).toBe('function');
      // The READ seam: how Results gets the server's sessions back.
      expect(typeof deps.hydrate.liveSessions?.list).toBe('function');
      // Building the bag talks to nothing.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
