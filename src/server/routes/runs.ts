/**
 * Runs REST router (PRD §7). Like the Recordings router: parse, call one store
 * method, map typed `StorageError`s. No `fs`, no aggregation.
 *
 * ============================ WIRE SHAPE (normative) =======================
 * POST /api/runs           Content-Type: application/json
 *        body: the COMPLETE client-produced Run record — the Realtime arm's Run
 *        is assembled in the browser and POSTed back, so the `id` arrives with
 *        it rather than being minted here.
 *      -> 201 Run
 * GET  /api/runs           -> 200 Run[]   (`?recordingId=` filters)
 * GET  /api/runs/:id/audio -> 200 WAV bytes, Content-Type audio/wav
 * ==========================================================================
 *
 * THE LEDGER IS APPEND-ONLY (PRD §17 20b). POST always appends: posting the
 * same Run id twice writes a second line and never rewrites the first, because
 * a read-modify-write of the ledger would put the entire benchmark history at
 * risk of one torn write. The route therefore has no upsert semantics to
 * expose — `appendRun` is the whole behaviour.
 *
 * FAILED RUNS ARE STORED AND LISTED LIKE ANY OTHER (PRD §12). `status:'failed'`
 * gets no special path here; readers exclude them from aggregates.
 *
 * Cascade output audio lands in the store server-side (the orchestrator writes
 * it), so this router only reads it. Failures answer the `{ code, message }`
 * envelope from ./http — a run with no output WAV is `run-audio-missing`.
 */
import { json, Router } from 'express';
import type { Request, Response } from 'express';

import type { Run, Storage } from '../storage';
import { handleAsync, JSON_BODY_LIMIT, sendWav } from './http';

export interface RunsRouterDeps {
  /** Injected so tests never touch the repo's data/ directory. */
  storage: Storage;
}

export function createRunsRouter(deps: RunsRouterDeps): Router {
  const { storage } = deps;
  const router = Router();
  const parseJson = json({ limit: JSON_BODY_LIMIT });

  router.post('/api/runs', parseJson, (req: Request, res: Response) => {
    handleAsync(res, async () => {
      // The Run is stored verbatim: it is the client's measurement record, and
      // rewriting any field here would change what the ledger claims happened.
      res.status(201).json(await storage.appendRun(req.body as Run));
    });
  });

  router.get('/api/runs', (req: Request, res: Response) => {
    handleAsync(res, async () => {
      const { recordingId } = req.query as { recordingId?: string };
      res.status(200).json(
        await storage.listRuns(recordingId === undefined ? {} : { recordingId }),
      );
    });
  });

  router.get('/api/runs/:id/audio', (req: Request, res: Response) => {
    handleAsync(res, async () => {
      sendWav(res, await storage.readRunAudio(req.params.id!));
    });
  });

  return router;
}
