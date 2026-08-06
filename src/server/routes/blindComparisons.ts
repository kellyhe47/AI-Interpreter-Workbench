/**
 * Blind-comparisons REST router (ticket 023 — QA F6). Like the Recordings and
 * Runs routers: validate, call one store method, answer the `{ code, message }`
 * envelope. No `fs`, no aggregation, no scoring logic.
 *
 * ============================ WIRE SHAPE (normative) =======================
 * POST /api/blind-comparisons   Content-Type: application/json
 *        body: the COMPLETE client-produced BlindComparison record — the
 *        draw, the scores and the evaluator's language are all decided in the
 *        browser, so the `id` arrives with it (same discipline as POST
 *        /api/runs).
 *      -> 201 BlindComparison
 * GET  /api/blind-comparisons   -> 200 BlindComparison[]  (`?recordingId=`
 *        filters)
 *
 * Failures answer the `{ code, message }` envelope from ./http; a malformed
 * body is `invalid-blind-comparison` -> 400.
 * ==========================================================================
 *
 * WHY THIS ROUTE EXISTS. A submitted comparison used to land in
 * `localStorage["workbench.runLedger.v1"]` and nowhere else: absent from the
 * `results/` bundle the write-up cites, lost with browser storage, and
 * unreachable from the second machine PRD §10 describes a coworker scoring on.
 * PRD §7 — the server owns the store; the client reads and writes it over REST.
 *
 * THE STREAM IS APPEND-ONLY (PRD §17 20b). POST always appends: the same
 * comparison id posted twice writes a second line and never rewrites the first,
 * because a read-modify-write would let a second submission silently erase the
 * first evaluator's judgement. The route therefore exposes no upsert.
 *
 * A DANGLING COMPARISON IS STILL STORED. `runIds` are NOT checked against the
 * run store here. The evaluator's work is never discarded because bookkeeping
 * cannot attribute it; whether a comparison can be COUNTED is a question the
 * export answers (`summary.blindComparisons.unattributable`), and answering it
 * at write time would mean destroying the only copy of a real judgement.
 *
 * VALIDATION IS STRUCTURAL, NOT EDITORIAL. The body must be a complete
 * BlindComparison — both runs, both draw slots, a non-blank evaluator language,
 * both samples' numeric scores, numeric timestamps. Anything less is refused
 * whole and nothing is written: a half-record in an append-only stream cannot
 * be repaired later.
 */
import { json, Router } from 'express';
import type { Request, Response } from 'express';

import type { BlindComparison, Storage } from '../storage';
import { handleAsync, JSON_BODY_LIMIT, sendBadRequest } from './http';

export interface BlindComparisonsRouterDeps {
  /** Injected so tests never touch the repo's data/ directory. */
  storage: Storage;
}

/** The rejection code, pinned: the client keys off it, so only wording is free. */
const INVALID = 'invalid-blind-comparison';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

/** Exactly two non-blank ids — a pairwise comparison has no other arity. */
function isIdPair(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && value.every(isNonEmptyString);
}

/** One sample's scores: both dimensions present, both finite numbers. */
function isSampleScores(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (['adequacy', 'fluency'] as const).every(
    (dimension) => typeof value[dimension] === 'number' && Number.isFinite(value[dimension]),
  );
}

/**
 * The structural gate. Returns WHY a body is not a BlindComparison, or `null`
 * when it is one — a reason rather than a boolean so the envelope's `message`
 * can name the field that was wrong.
 */
function rejectionReason(body: unknown): string | null {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isNonEmptyString(body.id)) return 'id must be a non-empty string';
  if (!isNonEmptyString(body.recordingId)) return 'recordingId must be a non-empty string';
  if (!isIdPair(body.runIds)) return 'runIds must be a pair of run ids';
  if (!isIdPair(body.order)) return 'order must be a pair of run ids';
  if (!isNonEmptyString(body.evaluatorLanguage)) {
    return 'evaluatorLanguage must be a non-empty string';
  }
  if (!isObject(body.scores)) return 'scores must name both samples';
  if (!isSampleScores(body.scores.A) || !isSampleScores(body.scores.B)) {
    return 'scores must give a numeric adequacy and fluency for samples A and B';
  }
  for (const stamp of ['createdAt', 'revealedAt'] as const) {
    if (typeof body[stamp] !== 'number' || !Number.isFinite(body[stamp])) {
      return `${stamp} must be a number`;
    }
  }
  return null;
}

export function createBlindComparisonsRouter(deps: BlindComparisonsRouterDeps): Router {
  const { storage } = deps;
  const router = Router();
  // `strict: false` so a JSON scalar (`"cmp-1"`, `null`) parses and reaches the
  // gate below as a value. Under the default, body-parser rejects it before any
  // handler runs and express answers its own HTML error page — a 400 with no
  // `{ code, message }` envelope, which is precisely the shape PRD §12 forbids.
  // A body that is not an object is our rejection to make, not the parser's.
  const parseJson = json({ limit: JSON_BODY_LIMIT, strict: false });

  router.post('/api/blind-comparisons', parseJson, (req: Request, res: Response) => {
    const reason = rejectionReason(req.body);
    if (reason !== null) {
      // Refused WHOLE: the store is not touched at all.
      sendBadRequest(res, INVALID, `not a blind comparison — ${reason}`);
      return;
    }
    handleAsync(res, async () => {
      // Stored verbatim: this is the evaluator's judgement, and rewriting any
      // field would change what the record claims was judged.
      res.status(201).json(await storage.appendBlindComparison(req.body as BlindComparison));
    });
  });

  router.get('/api/blind-comparisons', (req: Request, res: Response) => {
    handleAsync(res, async () => {
      const { recordingId } = req.query as { recordingId?: string };
      res
        .status(200)
        .json(
          await storage.listBlindComparisons(
            recordingId === undefined ? {} : { recordingId },
          ),
        );
    });
  });

  return router;
}
