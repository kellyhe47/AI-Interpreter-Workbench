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

import { werTokens } from '../../core/wer';
import type { Storage, WerScore } from '../storage';
import { handleAsync, JSON_BODY_LIMIT, sendBadRequest } from './http';

export interface WerScoresRouterDeps {
  /** Injected so tests never touch the repo's data/ directory. */
  storage: Storage;
}

/** The rejection code, pinned: the client keys off it, so only wording is free. */
export const INVALID_WER_SCORE = 'invalid-wer-score';

/** The two named reasons a WER could not be computed. Anything else is not one. */
const REASONS: readonly string[] = ['no-reference-text', 'no-hypothesis'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

/** A stored transcript: the text as captured, or an honest absence. */
function isTextOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

/**
 * The structural gate, plus the ONE semantic rule this ticket exists for.
 * Returns WHY a body is not a WerScore, or `null` when it is one — a reason
 * rather than a boolean, so the envelope's `message` can name the field.
 */
function rejectionReason(body: unknown): string | null {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isNonEmptyString(body.runId)) return 'runId must be a non-empty string';
  if (!isNonEmptyString(body.utteranceId)) return 'utteranceId must be a non-empty string';
  if (typeof body.scoredAt !== 'number' || !Number.isFinite(body.scoredAt)) {
    return 'scoredAt must be a number';
  }
  if (!isNonEmptyString(body.normalizationVersion)) {
    // Without it the number could never be recomputed, so it would be a figure
    // with no method — a claim rather than a measurement (PRD §8).
    return 'normalizationVersion must be a non-empty string, or the number could never be recomputed';
  }
  if (!isTextOrNull(body.referenceText)) return 'referenceText must be a string or null';
  if (!isTextOrNull(body.hypothesisText)) return 'hypothesisText must be a string or null';

  const { wer, notApplicableReason: reason } = body;

  // ===================== THE LOAD-BEARING PAIR ============================
  // `not applicable` and `0` must be impossible to confuse at the wire: a WER
  // of 0 is a PERFECT score, so a body carrying both a number and a reason is
  // REFUSED rather than stored for a reader to disambiguate later, and a null
  // with no reason is refused because it is indistinguishable from "nobody has
  // scored this yet".
  if (wer === null) {
    if (typeof reason !== 'string' || !REASONS.includes(reason)) {
      return `a null wer must name its reason — one of ${REASONS.join(', ')} — ` +
        'or it is indistinguishable from "not scored yet"';
    }
    if (
      reason === 'no-reference-text' &&
      !(body.referenceText === null || werTokens(body.referenceText as string).length === 0)
    ) {
      return 'no-reference-text is contradicted by a referenceText that is present';
    }
    if (reason === 'no-hypothesis' && body.hypothesisText !== null) {
      return 'no-hypothesis is contradicted by a hypothesisText that is present';
    }
    return null;
  }

  if (typeof wer !== 'number' || !Number.isFinite(wer) || wer < 0) {
    // Absent, a string, negative or NaN. Note what is NOT refused: a wer above
    // 1.0 is legal and stored UNCLAMPED — clamping would make a babbling arm
    // look like a silent one.
    return 'wer must be a non-negative finite number, or null with a named reason';
  }
  if (reason !== undefined) {
    return 'a numeric wer must not carry notApplicableReason — a wer of 0 is a PERFECT score, ' +
      'not "not applicable"';
  }
  if (typeof body.referenceText !== 'string') {
    return 'a numeric wer needs the referenceText it was measured against';
  }
  return null;
}

export function createWerScoresRouter(deps: WerScoresRouterDeps): Router {
  const { storage } = deps;
  const router = Router();
  // `strict: false` so a JSON scalar (`"score-1"`, `null`) parses and reaches
  // the gate below as a value. Under the default, body-parser rejects it before
  // any handler runs and express answers its own HTML error page — a 400 with
  // no `{ code, message }` envelope, which is precisely what PRD §12 forbids.
  const parseJson = json({ limit: JSON_BODY_LIMIT, strict: false });

  router.post('/api/wer-scores', parseJson, (req: Request, res: Response) => {
    const reason = rejectionReason(req.body);
    if (reason !== null) {
      // Refused WHOLE: the store is not touched at all, because a half-record
      // in an append-only stream cannot be repaired later.
      sendBadRequest(res, INVALID_WER_SCORE, `not a wer score — ${reason}`);
      return;
    }
    handleAsync(res, async () => {
      // Stored verbatim: the texts are kept pre-normalization so a reviewer can
      // recompute the number rather than trust it.
      res.status(201).json(await storage.appendWerScore(req.body as WerScore));
    });
  });

  router.get('/api/wer-scores', (_req: Request, res: Response) => {
    handleAsync(res, async () => {
      // UNCOLLAPSED, in write order: last-write-wins is a read-side rule with
      // exactly one home (`latestWerScores`), and collapsing here would both
      // duplicate it and hide the history the append-only stream exists for.
      res.status(200).json(await storage.listWerScores());
    });
  });

  return router;
}
