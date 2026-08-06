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
 *   deps.now()) is passed to TopBar ONLY on the Results view, and — ticket 025
 *   (QA F8) — only when Results is actually SHOWING results. A live session is
 *   not a run; provenance over it would be a category error, and so is
 *   provenance over 'No runs recorded'. PRD §8: "A number without provenance is
 *   a claim; a number with it is citable" — with no numbers there is nothing to
 *   make citable, and a corpus version stamped over an empty screen is a claim
 *   about a corpus that produced none of what is on it. The emptiness question
 *   is answered by ResultsView's own exported `resultsAreEmpty`, never by a
 *   second copy of the rule here, so the stamp cannot disagree with the panel.
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
 *
 * A SUBMITTED COMPARISON GOES TO BOTH DESTINATIONS (ticket 023, QA F6). The
 * default `recordBlindComparison` writes the ledger AND POSTs the very same
 * record to /api/blind-comparisons through `deps.replay.blindComparisons`.
 * PRD §7 gives the server the store, and PRD §10 expects a coworker to score on
 * the deployed instance — neither is reachable from localStorage alone. The
 * ORDER and the failure handling are load-bearing: the local write happens
 * FIRST and unconditionally, and a rejected POST is swallowed rather than
 * thrown, because the evaluator's judgement must survive an unreachable server.
 * A host that supplies no client keeps exactly the old behaviour.
 */

import { useCallback, useMemo, useReducer, useRef, useState, type ReactElement } from 'react';
import { buildBrowserDeps } from './browserDeps';
import { buildFixtureDeps, isFixtureMode } from './fixtureDeps';
import TopBar, { type WorkbenchView } from './components/TopBar';
import type { LedgerHydrationSource } from './state/hydrateLedger';
import type { BlindComparison } from './state/ledger';
import type { SessionStatus } from './state/sessionMachine';
import HelpView from './views/HelpView';
import ResultsView, { resultsAreEmpty } from './views/ResultsView';
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
   * TICKET 025 — the shell's view of the ledger's CONTENT.
   *
   * The ledger is a plain mutable store with no subscription, so nothing tells
   * the shell that hydration has landed records: ResultsView's own
   * `setHydration` re-renders ResultsView alone. `bumpContent` is that missing
   * signal — a re-render request carrying no value, because the ledger itself
   * IS the state — and `hydrating` is the shell's copy of "the panel is still
   * asking". Both are driven by the wrapper below, the only place App can
   * observe the hydration it merely forwards.
   */
  const [, bumpContent] = useReducer((version: number) => version + 1, 0);
  const [hydrating, setHydrating] = useState(deps.hydrate !== undefined);

  /**
   * `deps.hydrate` with completion observed, and NOTHING else changed — the
   * listings are forwarded verbatim, so ResultsView hydrates exactly as before.
   *
   * Memoized on `deps` (pinned for App's lifetime) because ResultsView re-runs
   * hydration whenever this identity changes; a fresh wrapper per render would
   * be an unbounded reload loop, and every re-render caused by the bump below
   * would trigger another.
   *
   * The bump is deferred to the next task rather than fired at resolution:
   * `hydrateLedger` awaits BOTH listings and appends afterwards, so a bump on
   * the resolution itself would re-read the ledger before the records reached
   * it and the stamp would stay hidden until some later, unrelated render.
   */
  const hydrate = useMemo<LedgerHydrationSource | undefined>(() => {
    const source = deps.hydrate;
    if (source === undefined) return undefined;

    let outstanding = 0;
    const observe = <T,>(list: () => Promise<T>): (() => Promise<T>) => {
      return async () => {
        if (outstanding === 0) setHydrating(true);
        outstanding += 1;
        try {
          return await list();
        } finally {
          outstanding -= 1;
          if (outstanding === 0) {
            setTimeout(() => {
              setHydrating(false);
              bumpContent();
            }, 0);
          }
        }
      };
    };

    return {
      recordings: { list: observe(() => source.recordings.list()) },
      runs: { list: observe(() => source.runs.list()) },
    };
  }, [deps]);

  /**
   * Whether Results currently has anything to attribute. `hydrating` counts as
   * "no": a panel still rendering its loading note is showing no figures, so a
   * corpus-version claim over it would describe data that has not arrived.
   *
   * Recomputed EVERY render rather than memoized: the input is a mutable ledger
   * with no identity change to key a cache on, so any dependency list would be
   * a list of the things that happen to change when it does — and would go
   * stale the first time one of them didn't. It is the same pair of reads
   * ResultsView already performs on the same render.
   */
  const resultsShowContent = !hydrating && !resultsAreEmpty(deps.ledger);

  /**
   * TICKET 023 — the default blind-comparison sink: the ledger FIRST, then the
   * server. See the file header for why the order and the swallowed rejection
   * are both deliberate.
   */
  const persistBlindComparison = useCallback(
    (comparison: BlindComparison): void => {
      deps.ledger.recordBlindComparison(comparison);
      // The SAME record, not a second derived copy: one judgement, two stores.
      void deps.replay?.blindComparisons?.create(comparison).catch(() => {
        // An unreachable server costs the server's copy and nothing else. The
        // reveal already happened and the local record stands; re-throwing here
        // would surface as an unhandled rejection and change nothing for the
        // evaluator except losing their place.
      });
    },
    [deps],
  );

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
      recordBlindComparison: bag.recordBlindComparison ?? persistBlindComparison,
    };
  }, [deps, persistBlindComparison]);

  // The dot describes the SESSION, not the navigation: no `view ===` gate.
  const live = LIVE_STATUSES.includes(controller.state.status);
  // Results-only AND content-only: see the header. Absent, never blanked.
  const provenance =
    view === 'results' && resultsShowContent
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
      // `deps.hydrate` is forwarded VERBATIM and is never synthesised from
      // `deps.replay`: wiring Replay is not a request for Results to go to the
      // network, and a host that wired only Replay must still see the client
      // ledger alone.
      body = <ResultsView ledger={deps.ledger} hydrate={hydrate} />;
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
