/**
 * Ticket 012/016 — App shell.
 *
 * `<App deps={appDeps} />` hosts TopBar + view switching between the FOUR
 * views — Live, Replay, Results, Help — over ONE shared deps bag.
 *
 * Contract (locked by App.test.tsx and exercised by every LiveView test,
 * all of which render <App deps={...} />):
 *
 * - EXACTLY ONE VIEW IS MOUNTED. Tabs are not panels: switching tab unmounts
 *   the view you left, so nothing off-screen keeps polling, playing or
 *   holding a stale copy of the ledger.
 * - Default view is Live (the idle card on first load).
 * - THE LIVE DOT REFLECTS SESSION STATE, NOT THE OPEN TAB. `live` is
 *   LIVE_STATUSES.includes(status) and nothing else. The pre-016 gate
 *   (`view === 'session' && …`) hid the dot the moment the user navigated
 *   away — but the session keeps running and keeps burning its five-minute
 *   budget while they read Replay, Results or Help, so hiding it there was a
 *   lie about the app's state.
 * - Run-provenance mono text ('run YYYY-MM-DD · corpus v1', date from
 *   deps.now()) is passed to TopBar ONLY on the Results view. A live session
 *   is not a run; provenance over it would be a category error.
 * - ONE DEPS BAG. The ledger a Live session appends to IS the ledger Results
 *   reads — same instance, no reload, no second copy.
 * - `deps` is optional ONLY for production main.tsx convenience: when
 *   omitted, App builds the real-browser deps (getUserMedia capture, real
 *   AudioContexts, real transports, localStorage-backed RunLedger, Date.now,
 *   and the REST-backed Replay bag). Tests always inject fakes.
 *
 * The session controller hook lives HERE (not inside LiveView) so the TopBar
 * live dot reads the same machine state the Live view renders, and so session
 * state — including the microphone grant — survives tab switches: a remount
 * of the controller would re-request the mic, which is exactly what the
 * locked test forbids.
 *
 * APP SUPPLIES THE BLIND SEAMS. `rng`, `evaluatorLanguage` and
 * `recordBlindComparison` are OPTIONAL on ReplayDeps, and ReplayView offers
 * NO blind-compare trigger at all — absent, not disabled — to a host that
 * omits them, because there is no honest blind mode without randomness and
 * somewhere to persist the draw. App is that host: it fills every one of the
 * three in, so the affordance exists in the real product, and a host bag that
 * supplies its own (a test pinning the draw) still wins.
 */

import { useMemo, useRef, useState, type ReactElement } from 'react';
import { buildBrowserDeps } from './browserDeps';
import { buildFixtureDeps, isFixtureMode } from './fixtureDeps';
import TopBar, { type WorkbenchView } from './components/TopBar';
import type { LedgerHydrationSource } from './state/hydrateLedger';
import type { SessionStatus } from './state/sessionMachine';
import HelpView from './views/HelpView';
import ResultsView from './views/ResultsView';
import LiveView from './views/LiveView';
import ReplayView, { type ReplayDeps } from './views/ReplayView';
import { useSessionController, type SessionDeps } from './views/useSessionController';

/**
 * Ticket 016 — one deps bag for all four views.
 *
 * `replay` carries the Replay-view seams (recordings/runs clients, the
 * executors, playback, clock, id minter). The three BLIND seams are
 * deliberately NOT part of what a host has to supply: App itself supplies
 * `rng`, `evaluatorLanguage` and `recordBlindComparison`, because they are
 * optional on ReplayDeps and a host that forgets them gets no blind-compare
 * trigger at all — absent, not disabled.
 */
export interface AppDeps extends SessionDeps {
  replay?: ReplayDeps;
  /**
   * TICKET 019 — the Results hydration seam (server Recordings + Runs → the
   * shared ledger), forwarded verbatim to <ResultsView hydrate={...} />.
   *
   * It is its OWN field rather than being derived from `deps.replay`: a host
   * that wires Replay has not thereby asked Results to go to the network, and
   * the locked App suite renders a fully-wired Replay bag while asserting
   * Results still reads the client ledger alone. Production (buildBrowserDeps)
   * supplies it; test bags that omit it get today's behaviour exactly.
   */
  hydrate?: LedgerHydrationSource;
}

export interface AppProps {
  deps?: AppDeps;
}

/** Statuses that count as "actively running" for the TopBar live dot. */
const LIVE_STATUSES: readonly SessionStatus[] = ['listening', 'processing', 'ready', 'playing'];

/**
 * The language a blind comparison is judged in when the host does not name
 * one. PRD §10 records it with every comparison because a rating is only
 * interpretable against the ear that produced it; the default is the target
 * language of the default pair (English → Spanish), and it is never blank —
 * an empty evaluator language is not an evaluator language.
 */
const DEFAULT_EVALUATOR_LANGUAGE = 'es';

/** Copy for a host that wired no Replay seams at all (never the product). */
const REPLAY_UNAVAILABLE = 'Replay is unavailable — this host supplied no recordings backend.';

export default function App(props: AppProps): ReactElement {
  const depsRef = useRef<AppDeps | null>(null);
  if (depsRef.current === null) {
    if (props.deps) {
      depsRef.current = props.deps;
    } else {
      // Ticket 018 — `?fixture=1` (or `?fixture=fail-mt`) swaps in the
      // scripted fixture deps so every live-session journey is reachable
      // without a grantable microphone. No flag → production deps,
      // byte-identical behavior to before.
      const fixture = isFixtureMode(window.location.search);
      depsRef.current = fixture.enabled
        ? buildFixtureDeps({ fault: fixture.fault })
        : buildBrowserDeps();
    }
  }
  const deps = depsRef.current;

  const controller = useSessionController(deps);
  const [view, setView] = useState<WorkbenchView>('live');

  /**
   * The Replay bag with the blind seams filled in. Memoized on `deps` — which
   * is pinned for the App's lifetime — because ReplayView re-lists recordings
   * and runs whenever its `deps` identity changes, and a fresh object per
   * render would turn that into an unbounded reload loop.
   */
  const replayDeps = useMemo<ReplayDeps | null>(() => {
    const bag = deps.replay;
    if (!bag) return null;
    return {
      ...bag,
      rng: bag.rng ?? Math.random,
      evaluatorLanguage: bag.evaluatorLanguage ?? DEFAULT_EVALUATOR_LANGUAGE,
      recordBlindComparison:
        bag.recordBlindComparison ?? ((comparison) => deps.ledger.recordBlindComparison(comparison)),
    };
  }, [deps]);

  // The dot describes the SESSION, not the navigation: no `view ===` gate.
  const live = LIVE_STATUSES.includes(controller.state.status);
  const provenance =
    view === 'results'
      ? `run ${new Date(deps.now()).toISOString().slice(0, 10)} · corpus v1`
      : null;

  /** Exactly one view is mounted; the rest are unmounted, not hidden. */
  let body: ReactElement;
  switch (view) {
    case 'live':
      body = <LiveView controller={controller} />;
      break;
    case 'replay':
      body =
        replayDeps === null ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
            {REPLAY_UNAVAILABLE}
          </p>
        ) : (
          <ReplayView deps={replayDeps} />
        );
      break;
    case 'results':
      body = <ResultsView ledger={deps.ledger} />;
      break;
    case 'help':
      body = <HelpView />;
      break;
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar view={view} onViewChange={setView} live={live} provenance={provenance} />
      <div
        style={{
          flex: 1,
          padding: '24px 32px 48px',
          maxWidth: 1060,
          width: '100%',
          margin: '0 auto',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {body}
      </div>
    </div>
  );
}
