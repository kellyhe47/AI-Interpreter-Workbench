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
import { advance, cascadeUtteranceScript, clickStartMicrophone, makeDeps } from './sessionTestKit';
import { isAggregatableLiveSession, type LiveSession } from '../state/ledger';

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

/* ===== TICKET 055a — THE MARK IS PRODUCED BY THE CLIENT THAT SHIPS ==========
 *
 * `:122` above pins that the write seam EXISTS in `buildBrowserDeps`. It does
 * not pin that the seam's FAILURE does anything, and this repo's #1 historical
 * failure — recurring as recently as ticket 064 — is a fix that satisfies the
 * test seam while production has zero callers. `sessionTestKit.makeDeps` builds
 * a `create` that a test wrote; a mark that only appears behind THAT proves
 * nothing about the app.
 *
 * So the seam under test here is the REAL one: `buildBrowserDeps().liveSessions`
 * — `createLiveSessionsClient` over the same injected fetch the deployed bundle
 * uses — handed to <App/> and driven by a real stopped session. The only fake is
 * `globalThis.fetch`, which is the network and nothing else. A 500 from
 * /api/live-sessions must reach the stored record as an unsynced mark.
 *
 * `syncState` is this ticket's proposed field, read through a narrow local cast.
 * ========================================================================== */

type SyncedLiveSession = LiveSession & { syncState?: string };

function syncStateOf(session: LiveSession): string | undefined {
  return (session as SyncedLiveSession).syncState;
}

/** A response stub — deliberately NOT a real Response, so nothing leaks out. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface ProductionPost {
  ledger: ReturnType<typeof makeDeps>['ledger'];
  calls: Array<{ url: string; method: string | undefined }>;
}

/**
 * Runs one real cascade take through <App/> with the PRODUCTION live-sessions
 * client wired to a fetch that answers `status`. Everything else is the test
 * kit's fakes (jsdom has no microphone, no AudioContext and no WebSocket).
 */
async function postTakeThroughProductionClient(status: number): Promise<ProductionPost> {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return jsonResponse(status, status >= 400 ? { message: `HTTP ${status}` } : { ok: true });
  });
  vi.stubGlobal('fetch', fetchSpy);
  vi.useFakeTimers();
  try {
    // THE PRODUCTION BAG. `liveSessions` here is the client the deployed app
    // POSTs through — not a `vi.fn` this file wrote.
    const production = buildBrowserDeps();
    let t = 0;
    const kit = makeDeps({
      now: () => t,
      initialState: { mode: 'cascade' },
      scripts: { cascade: cascadeUtteranceScript() },
    });
    render(<App deps={{ ...kit.deps, liveSessions: production.liveSessions }} />);

    await clickStartMicrophone();
    await advance(1_400);
    t = 60_000;
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await advance(100);

    return { ledger: kit.ledger, calls };
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}

describe('TICKET 055a — production wiring: the REAL client’s answer marks the take', () => {
  it('a 500 from /api/live-sessions leaves the app’s stored take UNSYNCED', async () => {
    const { ledger, calls } = await postTakeThroughProductionClient(500);

    // The production client really was the thing exercised: this URL and this
    // method exist nowhere in the test kit.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain('POST /api/live-sessions');

    const stored = ledger.getLiveSessions();
    expect(stored).toHaveLength(1);
    expect(syncStateOf(stored[0]!)).toBe('unsynced');
    expect(isAggregatableLiveSession(stored[0]!)).toBe(false);
  });

  it('a 201 from the same client leaves it synced — same path, other answer', async () => {
    const { ledger, calls } = await postTakeThroughProductionClient(201);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain('POST /api/live-sessions');

    const stored = ledger.getLiveSessions();
    expect(stored).toHaveLength(1);
    expect(syncStateOf(stored[0]!)).not.toBe('unsynced');
    expect(isAggregatableLiveSession(stored[0]!)).toBe(true);
  });

  it('the write seam and the hydration listing are ONE client, so an acknowledgement round-trips', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const deps = buildBrowserDeps();
      // Not merely "both are functions" (`:122`): the SAME object. Two clients
      // would let the seam that writes and the listing that acknowledges
      // disagree about which sessions the repo holds.
      expect(deps.liveSessions).toBe(deps.hydrate.liveSessions);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
