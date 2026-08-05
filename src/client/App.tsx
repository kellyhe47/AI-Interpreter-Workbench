/**
 * Ticket 012 — App shell.
 *
 * `<App deps={sessionDeps} />` hosts TopBar + view switching between
 * SessionView and ResultsView over ONE shared deps bag (the ledger inside
 * `deps` is the same instance both views read, so a stopped session's
 * appended records are immediately visible on Results).
 *
 * Contract (locked by App.test.tsx and exercised by every SessionView test,
 * all of which render <App deps={...} />):
 * - Default view is Session (idle card on first load).
 * - TopBar tabs switch views; exactly one view is mounted at a time.
 * - TopBar `live` is true only while the session is actively running.
 * - Run-provenance mono text ('run YYYY-MM-DD · corpus v1', date from
 *   deps.now()) is passed to TopBar ONLY on the Results view.
 * - `deps` is optional ONLY for production main.tsx convenience: when
 *   omitted, App builds the real-browser deps (getUserMedia capture,
 *   real AudioContexts, real transports, localStorage-backed RunLedger,
 *   Date.now). Tests always inject fakes.
 *
 * The session controller hook lives HERE (not inside SessionView) so the
 * TopBar live dot reads the same machine state the session view renders,
 * and session state survives tab switches.
 */

import { useRef, useState, type ReactElement } from 'react';
import { buildBrowserDeps } from './browserDeps';
import { buildFixtureDeps, isFixtureMode } from './fixtureDeps';
import TopBar, { type WorkbenchView } from './components/TopBar';
import type { SessionStatus } from './state/sessionMachine';
import ResultsView from './views/ResultsView';
import SessionView from './views/SessionView';
import { useSessionController, type SessionDeps } from './views/useSessionController';

export type AppDeps = SessionDeps;

export interface AppProps {
  deps?: AppDeps;
}

/** Statuses that count as "actively running" for the TopBar live dot. */
const LIVE_STATUSES: readonly SessionStatus[] = ['listening', 'processing', 'ready', 'playing'];

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
  const [view, setView] = useState<WorkbenchView>('session');

  const live = view === 'session' && LIVE_STATUSES.includes(controller.state.status);
  const provenance =
    view === 'results'
      ? `run ${new Date(deps.now()).toISOString().slice(0, 10)} · corpus v1`
      : null;

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
        {view === 'session' ? (
          <SessionView controller={controller} />
        ) : (
          <ResultsView ledger={deps.ledger} />
        )}
      </div>
    </div>
  );
}
