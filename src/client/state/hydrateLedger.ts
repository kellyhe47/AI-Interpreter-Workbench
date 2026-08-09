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
 * - LIVESESSIONS ARE HYDRATED TOO (ticket 041), through an OPTIONAL third
 *   listing. They used to have no server representation and were a purely
 *   browser-local soak record — which is the defect ticket 041 names: PRD §8
 *   wants one ledger under every view, and half of it was per-browser, so the
 *   stability artifact PRD §17 19i defines could not survive a reload, reach
 *   the exported bundle, or be read on a second machine. When a host wires no
 *   `liveSessions` listing, the LiveSession store is left untouched exactly as
 *   before. A ZERO-UTTERANCE session hydrates like any other: it is stored and
 *   listed, and kept out of figures by `isAggregatableLiveSession`, not by
 *   being dropped here.
 * - WER SCORES ARE HYDRATED TOO (ticket 034), through an OPTIONAL fourth
 *   listing, so Results can render a WER computed on another machine. The
 *   dedupe key is DIFFERENT from the others on purpose: a score has no id, and
 *   re-scoring the same (runId, utteranceId) is a LEGITIMATE second record. The
 *   key is therefore (runId, utteranceId, scoredAt) — repeated hydration adds
 *   nothing, while a genuine re-score still lands. Collapsing to one figure
 *   stays a read-side concern (`RunLedger.getWerScore`).
 * - FAILURE PROPAGATES. A rejected list() rejects the returned promise with
 *   the client's own `ApiError`, so the caller can tell "the backend is
 *   unreachable" from "the backend is empty" (PRD §12, and the F3 bug this
 *   must not re-create on a new screen).
 * ==========================================================================
 */

import { werScoreKey } from '../../core/wer';
import type { WerScore } from '../../core/wer';
import type {
  LiveSessionsClient,
  RecordingsClient,
  RunsClient,
  WerScoresClient,
} from '../replay/recordingsClient';
import type { LiveSession, RunLedger } from './ledger';

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
  /**
   * TICKET 034 — the fourth listing, OPTIONAL on the same terms: a host that
   * wires no WER backend (and every pre-034 test bag) gets exactly today's
   * behaviour and the score store is left untouched.
   */
  werScores?: Pick<WerScoresClient, 'list'>;
}

/**
 * Loads the server's Recordings, Runs and — when the host wires one —
 * LiveSessions into `ledger`.
 *
 * EVERY listing is awaited BEFORE anything is appended. That is what makes a
 * failure honest: a rejected `runs.list()` must not leave the ledger holding
 * Recordings it will then describe as having no Runs, which reads exactly like
 * a real empty sweep, and a rejected `liveSessions.list()` must not leave a
 * ledger whose Live half reads as a real, empty Live history. Either the whole
 * server view lands or none of it does, and the caller sees the `ApiError`.
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
  // A host with no live-session backend contributes an empty listing rather
  // than a second code path: "this host wires no seam" and "the server holds
  // no sessions" must both leave the LiveSession store exactly as it was.
  const [recordings, runs, liveSessions, werScores] = await Promise.all([
    source.recordings.list(),
    source.runs.list(),
    source.liveSessions?.list() ?? Promise.resolve<LiveSession[]>([]),
    source.werScores?.list() ?? Promise.resolve<WerScore[]>([]),
  ]);

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

  // Ticket 041 — the same append-and-dedupe rule, on session id. The take this
  // very tab just finished was appended locally at Stop and POSTed afterwards,
  // so the server's copy and the local one are ONE record, not two.
  const knownSessions = new Set(ledger.getLiveSessions().map((s) => s.id));
  for (const session of liveSessions) {
    if (knownSessions.has(session.id)) continue;
    knownSessions.add(session.id);
    ledger.appendLiveSession(session);
  }

  // TICKET 055a — THE LISTING IS THE SERVER'S ACKNOWLEDGEMENT, and it is the
  // only thing that can settle which takes the repo actually holds.
  //
  // WHY IT CANNOT RIDE THE DEDUPE ABOVE: the merge is ADD-ONLY and never
  // replaces, so a browser whose copy of a session is stale (the POST failed at
  // Stop, and the server got the take another way — a retry, a second tab, the
  // export) skips it on id forever. That is precisely the machine with the
  // problem, so re-hydration overwriting the local record cannot be the
  // mechanism; the mark has to be settled explicitly.
  //
  // IT CUTS BOTH WAYS, and neither direction is a filter on the store: a
  // session the listing NAMES is one the repo has, and a session it does not
  // name is one the repo does not have. Both are statements this listing is
  // entitled to make, because `list()` is unfiltered — it is the whole server
  // view of the Live half.
  //
  // AND A HOST WITH NO LISTING LEARNS NOTHING. `source.liveSessions` absent is
  // a host wiring no live-session backend (every pre-041 bag), which carries no
  // statement about anything: inventing an acknowledgement out of a listing that
  // was never asked for would be the worse of the two errors, and demoting a
  // take on the same non-evidence would be the other. The key's presence is what
  // is read here, never the emptiness of the array — a server that legitimately
  // holds nothing still says so.
  if (source.liveSessions !== undefined) {
    const acknowledged = new Set(liveSessions.map((s) => s.id));
    for (const stored of ledger.getLiveSessions()) {
      if (acknowledged.has(stored.id)) ledger.markLiveSessionSynced(stored.id);
      else ledger.markLiveSessionUnsynced(stored.id);
    }
  }

  // TICKET 034 — the same append-and-dedupe rule, on a DIFFERENT key. A score
  // has no id, and re-scoring the same (runId, utteranceId) is a LEGITIMATE
  // second record, so identity cannot be the key: hydrating twice must add
  // nothing while a genuine re-score must still land. (runId, utteranceId,
  // scoredAt) is the narrowest key that tells those two apart. Collapsing to
  // one figure stays a read-side concern (`RunLedger.getWerScore`).
  const scoreKey = (score: WerScore): string =>
    `${werScoreKey(score.runId, score.utteranceId)}\u001f${score.scoredAt}`;
  const knownScores = new Set(ledger.getWerScores().map(scoreKey));
  for (const score of werScores) {
    const key = scoreKey(score);
    if (knownScores.has(key)) continue;
    knownScores.add(key);
    ledger.appendWerScore(score);
  }
}
