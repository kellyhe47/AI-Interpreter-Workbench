/**
 * WER scores REST router (TICKET 034). Like the Recordings, Runs,
 * BlindComparisons and LiveSessions routers: validate, call one store method,
 * answer the `{ code, message }` envelope. No `fs`, no scoring, no aggregation.
 *
 * ============================ WIRE SHAPE (normative) =======================
 * POST /api/wer-scores   Content-Type: application/json
 *        body: ONE complete WerScore — scoring is local string work done by the
 *        caller (src/core/wer.ts), so the computed number arrives with its
 *        (runId, utteranceId) key, same discipline as POST /api/runs.
 *      -> 201 WerScore
 * GET  /api/wer-scores   -> 200 WerScore[]  (write order, UNCOLLAPSED)
 *
 * A malformed body is `invalid-wer-score` -> 400, in the `{ code, message }`
 * envelope from ./http.
 * ==========================================================================
 *
 * WHY THIS ROUTE EXISTS. WER is one of the four measured quality dimensions and
 * had no server-side representation at all. It is scored POST HOC against the
 * corpus manifest's `referenceText`, and the append-only Run store deliberately
 * has no update route — so WER needed its own destination rather than a mutation
 * of a Run that has already been written.
 *
 * ITS OWN STREAM, NEVER ledger.jsonl. `readLedger()` is typed `Run[]` and
 * `exportResults` unions it into the exported RUN record set; a score sharing
 * that file would be counted in `totals.runs`.
 *
 * THE GET IS UNCOLLAPSED. Re-scoring the same (runId, utteranceId) appends a
 * SECOND record and both come back. Last-write-wins is a READ-SIDE collapse
 * (`latestWerScores`), applied by the reader that needs one figure; doing it
 * here would make the route the second place the rule lives, and would hide the
 * history the append-only stream exists to keep.
 *
 * VALIDATION IS STRUCTURAL, NOT EDITORIAL — with ONE semantic rule that is the
 * whole reason this ticket exists:
 *
 *   A `wer` OF `null` MUST NAME ITS REASON, AND A NUMERIC `wer` MUST NOT.
 *
 * Cantonese is improvised from English prompt cards and has no written script
 * (PRD §9), so it is `not applicable` — and a WER of 0 is a PERFECT score, the
 * worst possible way to render "no reference". The two must be impossible to
 * confuse at the wire, so a body carrying both a number and a
 * `notApplicableReason` is refused rather than stored for a reader to
 * disambiguate later.
 *
 * WHAT IS ACCEPTED THAT A READER LATER EXCLUDES. A score against a fixture,
 * manual or failed run is STORED: ticket 018's rule is a rule about REPORTING,
 * and refusing it here would destroy a record. The realness rule and the
 * aggregation gate keep it out of a figure, exactly as they do for latency.
 */
import { json, Router } from 'express';
import type { Request, Response } from 'express';

import type { Storage, WerScore } from '../storage';
import { handleAsync, JSON_BODY_LIMIT, sendBadRequest } from './http';

export interface WerScoresRouterDeps {
  /** Injected so tests never touch the repo's data/ directory. */
  storage: Storage;
}

/** The rejection code, pinned: the client keys off it, so only wording is free. */
export const INVALID_WER_SCORE = 'invalid-wer-score';

export function createWerScoresRouter(deps: WerScoresRouterDeps): Router {
  // TICKET 034 stub. The router is CONSTRUCTED (so mounting it shadows nothing
  // and every other suite stays green) and its handlers are not implemented.
  void deps;
  const router = Router();

  router.post('/api/wer-scores', json({ limit: JSON_BODY_LIMIT, strict: false }), (_req: Request, res: Response) => {
    handleAsync(res, async () => {
      throw new Error('ticket 034: not implemented');
    });
  });

  router.get('/api/wer-scores', (_req: Request, res: Response) => {
    handleAsync(res, async () => {
      throw new Error('ticket 034: not implemented');
    });
  });

  return router;
}
