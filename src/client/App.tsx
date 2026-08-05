/**
 * Ticket 012 — App shell (STUB — tests written first; the previous trivial
 * App.tsx was disposable and is replaced by this contract).
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
 */

import type { ReactElement } from 'react';
import type { SessionDeps } from './views/useSessionController';

export type AppDeps = SessionDeps;

export interface AppProps {
  deps?: AppDeps;
}

export default function App(_props: AppProps): ReactElement {
  throw new Error('App not implemented (ticket 012)');
}
