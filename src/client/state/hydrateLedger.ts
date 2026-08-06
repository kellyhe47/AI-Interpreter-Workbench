/**
 * TICKET 019 — the hydration seam: server-persisted Recordings and Runs into
 * the client ledger.
 *
 * PRD §8: "One ledger under every view. Every screen reads from a single
 * append-only run ledger… the ledger is the source of truth, so a metric
 * cannot drift between screens or between a screen and the write-up."
 *
 * Before this seam existed, Replay read the server over REST while Results
 * read a disjoint browser-local `RunLedger` — two stores, so a real batch
 * sweep left the project's primary deliverable empty.
 *
 * ============================ DESIGN (normative) ===========================
 * - INJECTED, NEVER GLOBAL. The source is the same pair of clients ReplayView
 *   already uses (`createRecordingsClient` / `createRunsClient`), narrowed to
 *   the one method hydration needs. No `fetch` is reachable from here, so a
 *   test drives hydration without a network and without a mock server.
 * - APPEND-ONLY AND IDEMPOTENT. The ledger is append-only by construction, so
 *   hydration appends what is not already there, keyed on entity id. A record
 *   a Live session appended locally is never duplicated and never dropped —
 *   hydration ADDS the server's view, it does not replace the client's.
 * - RUNS ARE FETCHED UNFILTERED. `runs.list()` with no recordingId: Results
 *   aggregates across every Recording, so a per-Recording listing would be a
 *   second, narrower gate.
 * - LIVESESSIONS ARE NOT HYDRATED. They have no server representation; they
 *   are a client-side soak record. Hydration must leave that store untouched.
 * - FAILURE PROPAGATES. A rejected list() rejects the returned promise with
 *   the client's own `ApiError`, so the caller can tell "the backend is
 *   unreachable" from "the backend is empty" (PRD §12, and the F3 bug this
 *   must not re-create on a new screen).
 * ==========================================================================
 */

import type { RecordingsClient, RunsClient } from '../replay/recordingsClient';
import type { RunLedger } from './ledger';

/**
 * The seam ResultsView is handed. Narrowed to `list` on purpose: hydration
 * reads, it never writes to the server.
 */
export interface LedgerHydrationSource {
  recordings: Pick<RecordingsClient, 'list'>;
  runs: Pick<RunsClient, 'list'>;
}

/**
 * Loads the server's Recordings and Runs into `ledger`.
 *
 * STUB (ticket 019, red): does nothing.
 */
export async function hydrateLedger(
  _ledger: RunLedger,
  _source: LedgerHydrationSource,
): Promise<void> {
  return Promise.resolve();
}
