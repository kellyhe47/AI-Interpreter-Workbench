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

import type {
  LiveSessionsClient,
  RecordingsClient,
  RunsClient,
} from '../replay/recordingsClient';
import type { RunLedger } from './ledger';

/**
 * The seam ResultsView is handed. Narrowed to `list` on purpose: hydration
 * reads, it never writes to the server.
 */
export interface LedgerHydrationSource {
  recordings: Pick<RecordingsClient, 'list'>;
  runs: Pick<RunsClient, 'list'>;
  /**
   * TICKET 041 — the third listing. OPTIONAL: a host that wires no
   * live-session backend (and every pre-041 test bag) gets exactly today's
   * behaviour, and the LiveSession store is left untouched.
   *
   * When present it is loaded with the other two and under the same rules —
   * awaited BEFORE anything is appended (atomic on failure) and idempotent on
   * session id — so Results shows the Live metrics after a reload or on
   * another machine, which is what makes PRD §17 19i's stability artifact
   * survive at all.
   */
  liveSessions?: Pick<LiveSessionsClient, 'list'>;
}

/**
 * Loads the server's Recordings and Runs into `ledger`.
 *
 * BOTH listings are awaited BEFORE anything is appended. That is what makes a
 * failure honest: a rejected `runs.list()` must not leave the ledger holding
 * Recordings it will then describe as having no Runs, which reads exactly like
 * a real empty sweep. Either the whole server view lands or none of it does,
 * and the caller sees the `ApiError`.
 *
 * Nothing is filtered and nothing is re-gated here: the aggregation gate lives
 * in the ledger (`isAggregatableRun`), so hydration loads the store verbatim
 * and every excluded Run stays listable — loading more data must never load
 * more data PAST the gate.
 */
export async function hydrateLedger(
  ledger: RunLedger,
  source: LedgerHydrationSource,
): Promise<void> {
  const [recordings, runs] = await Promise.all([source.recordings.list(), source.runs.list()]);

  // Idempotent on entity id. The ledger is append-only and may already hold a
  // locally-appended Run (a Replay run this tab just executed) or the same
  // server entity from an earlier hydration; neither may be duplicated, and
  // neither may be dropped.
  const knownRecordings = new Set(ledger.getRecordings().map((r) => r.id));
  for (const recording of recordings) {
    if (knownRecordings.has(recording.id)) continue;
    knownRecordings.add(recording.id);
    ledger.appendRecording(recording);
  }

  const knownRuns = new Set(ledger.getRuns().map((r) => r.id));
  for (const run of runs) {
    if (knownRuns.has(run.id)) continue;
    knownRuns.add(run.id);
    ledger.appendRun(run);
  }
}
