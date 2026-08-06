/**
 * STUB (ticket 023 — test-writer). Blind-comparisons REST router.
 *
 * NO IMPLEMENTATION: this file exists only so the failing tests in
 * ./blindComparisons.test.ts compile and can be mounted. The router it returns
 * carries no routes at all.
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
 */
import { Router } from 'express';

import type { Storage } from '../storage';

export interface BlindComparisonsRouterDeps {
  /** Injected so tests never touch the repo's data/ directory. */
  storage: Storage;
}

export function createBlindComparisonsRouter(_deps: BlindComparisonsRouterDeps): Router {
  return Router();
}
