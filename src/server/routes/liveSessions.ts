/**
 * LiveSessions REST router (TICKET 041). Like the Recordings, Runs and
 * BlindComparisons routers: validate, call one store method, answer the
 * `{ code, message }` envelope. No `fs`, no aggregation, no derivation.
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
 *
 * WHAT IS ACCEPTED THAT A READER LATER EXCLUDES. A ZERO-UTTERANCE session and a
 * FIXTURE-sourced session are both stored: refusing them here would destroy the
 * record of a take that produced nothing, which is the finding itself, and
 * ticket 018's fixture rule is a rule about REPORTING, not about writing. The
 * gate that keeps either out of a figure is `isAggregatableLiveSession` on the
 * client and `summary.liveSessions` in the export.
 *
 * VALIDATION IS STRUCTURAL, NOT EDITORIAL. The body must be a complete
 * LiveSession — an id, a known architecture, numeric timestamps, an array of
 * fully-formed utterances, and the four metric envelopes. Anything less is
 * refused whole and nothing is written: a half-record in an append-only stream
 * cannot be repaired later.
 */
import { json, Router } from 'express';
import type { Request, Response } from 'express';

import type { LiveSession, Storage } from '../storage';
import { handleAsync, JSON_BODY_LIMIT, sendBadRequest } from './http';

export interface LiveSessionsRouterDeps {
  /** Injected so tests never touch the repo's data/ directory. */
  storage: Storage;
}

/** The rejection code, pinned: the client keys off it, so only wording is free. */
export const INVALID_LIVE_SESSION = 'invalid-live-session';

/** The two architectures PRD §3 measures. Anything else is not a mode. */
const MODES: readonly string[] = ['cascade', 'realtime'];

/**
 * Fields that would mean audio travelled with the session. Named explicitly
 * rather than inferred, so the refusal is a stated rule and not a side effect
 * of the shape happening to lack them (PRD §17 19h).
 */
const AUDIO_FIELDS: readonly string[] = ['audioBase64', 'outputAudioPath', 'audioPath', 'audio'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function isNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A measured figure or an honest "not measured" — never a fabricated 0. */
function isNumberOrNull(value: unknown): boolean {
  return value === null || isNumber(value);
}

/** Every key of `shape` present on `value` and of the right kind. */
function hasFields(
  value: unknown,
  shape: Record<string, (field: unknown) => boolean>,
): boolean {
  if (!isObject(value)) return false;
  return Object.entries(shape).every(([key, ok]) => ok(value[key]));
}

/** One metrics-only utterance row: an id, its marks, and what it cost. */
function isUtterance(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isObject(value.timings)) return false;
  if (!Object.values(value.timings).every(isNumberOrNull)) return false;
  // TICKET 052 — `null` is a LEGAL costUsd: it says the utterance could not be
  // metered. Rejecting it would force the client to post a 0, which is the
  // `$0.00` lie one layer down.
  return isNumberOrNull(value.costUsd);
}

/**
 * The structural gate. Returns WHY a body is not a LiveSession, or `null` when
 * it is one — a reason rather than a boolean so the envelope's `message` can
 * name the field that was wrong.
 */
function rejectionReason(body: unknown): string | null {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isNonEmptyString(body.id)) return 'id must be a non-empty string';
  for (const field of AUDIO_FIELDS) {
    if (body[field] !== undefined) {
      return `Live persists no audio, so "${field}" has no place on a session (PRD §17 19h)`;
    }
  }
  if (typeof body.architecture !== 'string' || !MODES.includes(body.architecture)) {
    return `architecture must be one of ${MODES.join(', ')}`;
  }
  for (const stamp of ['startedAt', 'endedAt', 'durationMs'] as const) {
    if (!isNumber(body[stamp])) return `${stamp} must be a number`;
  }
  if (!isObject(body.modelSnapshots)) return 'modelSnapshots must be an object';
  if (!Array.isArray(body.utterances)) return 'utterances must be an array';
  if (!body.utterances.every(isUtterance)) {
    return 'every utterance must carry an id, its timings and a numeric-or-null costUsd';
  }
  if (
    !hasFields(body.latency, {
      p50: isNumberOrNull,
      p95: isNumberOrNull,
      driftMinute1ToEnd: isNumberOrNull,
    })
  ) {
    return 'latency must give p50, p95 and driftMinute1ToEnd as numbers or null';
  }
  if (
    !hasFields(body.cost, {
      // TICKET 052 — `null` totalUsd means the session could not be priced.
      totalUsd: isNumberOrNull,
      perMinuteMinute1: isNumberOrNull,
      perMinuteFinalMinute: isNumberOrNull,
    })
  ) {
    return 'cost must give a numeric-or-null totalUsd and per-minute figures or null';
  }
  if (
    !hasFields(body.stability, {
      utterancesCompleted: isNumber,
      disconnects: isNumber,
      heapStart: isNumberOrNull,
      heapEnd: isNumberOrNull,
    })
  ) {
    return 'stability must give numeric counters and heap figures or null';
  }
  // PRD §7: free conversation has no reference transcript, so a WER on a Live
  // session is a FABRICATED measurement, not a missing one. `null` is the only
  // honest value, and the shape says so.
  if (!isObject(body.quality) || body.quality.wer !== null) {
    return 'quality.wer must be null — Live has no reference transcript to score against';
  }
  return null;
}

export function createLiveSessionsRouter(deps: LiveSessionsRouterDeps): Router {
  const { storage } = deps;
  const router = Router();
  // `strict: false` so a JSON scalar (`"live-1"`, `null`) parses and reaches
  // the gate below as a value. Under the default, body-parser rejects it before
  // any handler runs and express answers its own HTML error page — a 400 with
  // no `{ code, message }` envelope, which is precisely what PRD §12 forbids.
  const parseJson = json({ limit: JSON_BODY_LIMIT, strict: false });

  router.post('/api/live-sessions', parseJson, (req: Request, res: Response) => {
    const reason = rejectionReason(req.body);
    if (reason !== null) {
      // Refused WHOLE: the store is not touched at all.
      sendBadRequest(res, INVALID_LIVE_SESSION, `not a live session — ${reason}`);
      return;
    }
    handleAsync(res, async () => {
      // Stored verbatim: the session IS the stability artifact, so rewriting
      // any field here would change what the record claims was measured.
      res.status(201).json(await storage.appendLiveSession(req.body as LiveSession));
    });
  });

  router.get('/api/live-sessions', (_req: Request, res: Response) => {
    handleAsync(res, async () => {
      // Unfiltered and unsorted beyond write order: Results and the export both
      // aggregate across every session, so a narrower listing here would be a
      // second, invisible gate.
      res.status(200).json(await storage.listLiveSessions());
    });
  });

  return router;
}
