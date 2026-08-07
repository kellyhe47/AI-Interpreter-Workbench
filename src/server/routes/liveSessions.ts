/**
 * LiveSessions REST router (TICKET 041). STUB — the handlers are the
 * implementation's to write; this file exists so the suite compiles and mounts.
 *
 * ============================ WIRE SHAPE (normative) =======================
 * POST /api/live-sessions   Content-Type: application/json
 *        body: the COMPLETE client-produced LiveSession record — the metrics
 *        are computed in the browser when the session stops, so the `id`
 *        arrives with it (same discipline as POST /api/runs and
 *        POST /api/blind-comparisons).
 *      -> 201 LiveSession
 * GET  /api/live-sessions   -> 200 LiveSession[]  (write order, unfiltered)
 *
 * A malformed body is `invalid-live-session` -> 400, in the `{ code, message }`
 * envelope from ./http.
 * ==========================================================================
 *
 * WHY THIS ROUTE EXISTS. A Live session used to land in
 * `localStorage["workbench.runLedger.v1"]` and nowhere else — absent from
 * `data/`, absent from the `results/` bundle the write-up cites, destroyed by
 * clearing site data, unreachable from a second machine. PRD §17 19i makes
 * every Live session THE stability artifact, so that artifact could not leave
 * the browser it was recorded in.
 *
 * ITS OWN STREAM, NEVER ledger.jsonl. `readLedger()` is typed `Run[]` and
 * `exportResults` unions it into the exported RUN record set; a session sharing
 * that file would be counted in `totals.runs` and derived into an arm. A soak
 * measurement over free conversation is not a Run over a fixed Recording.
 *
 * NO AUDIO (PRD §17 19h, unchanged). The stored shape has no audio-bearing
 * field, and the route refuses a body that carries one rather than silently
 * storing it.
 */
import { Router } from 'express';

import type { Storage } from '../storage';

export interface LiveSessionsRouterDeps {
  /** Injected so tests never touch the repo's data/ directory. */
  storage: Storage;
}

/** The rejection code, pinned: the client keys off it, so only wording is free. */
export const INVALID_LIVE_SESSION = 'invalid-live-session';

export function createLiveSessionsRouter(_deps: LiveSessionsRouterDeps): Router {
  // TICKET 041 — deliberately empty: no handler is registered yet, so every
  // request 404s and the suite is red until the route is written.
  return Router();
}
