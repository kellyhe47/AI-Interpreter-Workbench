/**
 * Runs REST router (PRD §7). Like the Recordings router: parse, call one store
 * method, map typed `StorageError`s. No `fs`, no aggregation.
 *
 * ============================ WIRE SHAPE (normative) =======================
 * POST /api/runs            Content-Type: application/json
 *        body: the COMPLETE client-produced Run record — the Realtime arm's Run
 *        is assembled in the browser and POSTed back, so the `id` arrives with
 *        it rather than being minted here.
 *      -> 201 Run
 * GET  /api/runs            -> 200 Run[]   (`?recordingId=` filters)
 * GET  /api/runs/:id/audio  -> 200 WAV bytes, Content-Type audio/wav
 * POST /api/runs/:id/audio  Content-Type: application/json
 *        body: { audioBase64 } — the 24 kHz mono PCM16 WAV, base64
 *      -> 201 { id, outputAudioPath, bytes }
 *      -> 400 { code: 'invalid-run-audio', message }
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
 * TICKET 045 — OUTPUT AUDIO HAS ITS OWN ENDPOINT, AND ITS OWN VALIDATION.
 * The bytes are produced in the BROWSER (the Replay runner buffers what the
 * transport synthesized) and must be uploaded, so this router both reads and
 * writes them. They get their own request because `POST /api/runs` stores its
 * body verbatim and `appendRun` writes the whole Run as ONE LINE of
 * ledger.jsonl — base64 audio in that body would put megabytes into every line
 * of the append-only benchmark history.
 *
 * Unlike the Run body (passed through untouched, AGENTS.md), the upload body is
 * VALIDATED: a missing, non-string or EMPTY `audioBase64` is a 400
 * `invalid-run-audio` and writes NOTHING. A zero-byte runs/<id>.out.wav would
 * make GET /audio answer 200-with-silence instead of the honest 404, and the
 * play control — which gates on `Run.outputAudioPath` — would offer a button
 * that plays nothing.
 *
 * THE UPLOAD DOES NOT REQUIRE THE RUN TO EXIST. The client uploads FIRST and
 * POSTs the Run SECOND, carrying the path this route reports, so
 * `Run.outputAudioPath` is a report of bytes already on disk rather than a
 * promise the append-only ledger could never retract. Failed runs upload like
 * any other (PRD §12): this route is handed no `status` to branch on.
 *
 * Failures answer the `{ code, message }` envelope from ./http — a run with no
 * output WAV is `run-audio-missing`.
 */
import { json, Router } from 'express';
import type { Request, Response } from 'express';

import { runAudioStorePath } from '../storage';
import type { Run, Storage } from '../storage';
import { handleAsync, JSON_BODY_LIMIT, sendBadRequest, sendWav } from './http';

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

  router.post('/api/runs/:id/audio', parseJson, (req: Request, res: Response) => {
    const { audioBase64 } = (req.body ?? {}) as { audioBase64?: unknown };
    if (typeof audioBase64 !== 'string') {
      sendBadRequest(res, 'invalid-run-audio', 'audioBase64 must be a base64 string');
      return;
    }
    if (audioBase64.length === 0) {
      // Rejected BEFORE the store is touched: writing zero bytes here would
      // leave a file that answers GET /audio with 200-and-nothing.
      sendBadRequest(res, 'invalid-run-audio', 'audioBase64 must not be empty');
      return;
    }
    handleAsync(res, async () => {
      const id = req.params.id!;
      const bytes = new Uint8Array(Buffer.from(audioBase64, 'base64'));
      await storage.writeRunAudio(id, bytes);
      // The SERVER reports the path — see the header.
      res.status(201).json({ id, outputAudioPath: runAudioStorePath(id), bytes: bytes.length });
    });
  });

  return router;
}
