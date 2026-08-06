/**
 * Recordings REST router (PRD §7). A thin HTTP skin over the `Storage` layer:
 * it parses the wire shape, calls exactly one store method, and maps typed
 * `StorageError`s onto status codes. It never reaches for `fs` itself.
 *
 * ============================ WIRE SHAPE (normative) =======================
 * POST   /api/recordings           Content-Type: application/json
 *          { label, sourceLanguage, durationMs, speechEndMs, origin,
 *            createdAt?, audioBase64 }
 *        -> 201 Recording (with the store-generated `id`)
 * GET    /api/recordings           -> 200 Recording[]  (soft-deleted omitted)
 * GET    /api/recordings/:id       -> 200 Recording | 404
 * GET    /api/recordings/:id/audio -> 200 WAV bytes, Content-Type audio/wav
 * PATCH  /api/recordings/:id       { label } -> 200 Recording  (label ONLY)
 * DELETE /api/recordings/:id       -> 200 Recording | 409 for a corpus clip
 * ==========================================================================
 *
 * AUDIO RIDES AS BASE64 IN THE JSON BODY — not multipart, not a raw body. One
 * request carries the metadata and the bytes together, so a Recording is never
 * half-created and the client needs no upload state machine. See
 * `JSON_BODY_LIMIT` in ./http for why the body limit is raised.
 *
 * AUDIO IS IMMUTABLE (PRD §7). PATCH accepts `label` and ignores every other
 * field in the body — `durationMs`, `origin`, `id`, `audioBase64` included.
 * Every number already in the ledger was measured against these exact bytes.
 *
 * Failures answer the `{ code, message }` envelope from ./http.
 */
import { json, Router } from 'express';
import type { Request, Response } from 'express';

import { validateManifest, type CorpusUtterance } from '../../core/corpus';
import type { NewRecording, RecordingOrigin, Storage } from '../storage';
import { handleAsync, JSON_BODY_LIMIT, sendBadRequest, sendWav } from './http';

export interface RecordingsRouterDeps {
  /** Injected so tests never touch the repo's data/ directory. */
  storage: Storage;
}

interface RecordingUploadBody {
  label?: unknown;
  sourceLanguage?: unknown;
  durationMs?: unknown;
  speechEndMs?: unknown;
  origin?: unknown;
  createdAt?: unknown;
  audioBase64?: unknown;
  utterances?: unknown;
  corpusVersion?: unknown;
}

/** Thrown by `parseUpload` for a malformed body; mapped to 400 by the handler. */
class InvalidUpload extends Error {}

function parseUpload(body: RecordingUploadBody | undefined): {
  meta: NewRecording;
  audio: Uint8Array;
} {
  const {
    label,
    sourceLanguage,
    durationMs,
    speechEndMs,
    origin,
    createdAt,
    audioBase64,
    utterances,
    corpusVersion,
  } = body ?? {};

  if (typeof label !== 'string') throw new InvalidUpload('label must be a string');
  if (typeof sourceLanguage !== 'string') {
    throw new InvalidUpload('sourceLanguage must be a string');
  }
  if (typeof durationMs !== 'number') {
    throw new InvalidUpload('durationMs must be a number');
  }
  if (typeof speechEndMs !== 'number') {
    throw new InvalidUpload('speechEndMs must be a number');
  }
  if (origin !== 'mic' && origin !== 'corpus') {
    throw new InvalidUpload("origin must be 'mic' or 'corpus'");
  }
  if (typeof audioBase64 !== 'string') {
    throw new InvalidUpload('audioBase64 must be a base64 string');
  }

  const meta: NewRecording = {
    label,
    sourceLanguage,
    durationMs,
    speechEndMs,
    origin: origin as RecordingOrigin,
  };
  if (typeof createdAt === 'number') meta.createdAt = createdAt;

  // Ticket 030. Unlike the runs route, recordings VALIDATE rather than pass
  // unknown keys through: a malformed manifest does not fail loudly later, it
  // silently mis-attributes every category and WER figure derived from it.
  if (utterances !== undefined) {
    if (!Array.isArray(utterances)) throw new InvalidUpload('utterances must be an array');
    const reason = validateManifest(utterances as CorpusUtterance[], durationMs);
    if (reason !== null) throw new InvalidUpload(reason);
    meta.utterances = utterances as CorpusUtterance[];
  }
  if (corpusVersion !== undefined) {
    if (typeof corpusVersion !== 'string' || corpusVersion.length === 0) {
      throw new InvalidUpload('corpusVersion must be a non-empty string');
    }
    meta.corpusVersion = corpusVersion;
  }

  return { meta, audio: new Uint8Array(Buffer.from(audioBase64, 'base64')) };
}

export function createRecordingsRouter(deps: RecordingsRouterDeps): Router {
  const { storage } = deps;
  const router = Router();
  const parseJson = json({ limit: JSON_BODY_LIMIT });

  router.post('/api/recordings', parseJson, (req: Request, res: Response) => {
    let upload: { meta: NewRecording; audio: Uint8Array };
    try {
      upload = parseUpload(req.body as RecordingUploadBody | undefined);
    } catch (err) {
      sendBadRequest(res, 'invalid-recording', (err as Error).message);
      return;
    }
    handleAsync(res, async () => {
      res.status(201).json(await storage.createRecording(upload.meta, upload.audio));
    });
  });

  router.get('/api/recordings', (_req: Request, res: Response) => {
    handleAsync(res, async () => {
      // Soft-deleted Recordings are omitted: that is the store's default.
      res.status(200).json(await storage.listRecordings());
    });
  });

  router.get('/api/recordings/:id/audio', (req: Request, res: Response) => {
    handleAsync(res, async () => {
      // Deliberately NOT gated on getRecording first: audio that is not there
      // is `recording-audio-missing` whether the metadata vanished too or only
      // the WAV did. One code, one client behaviour — the clip is unplayable.
      sendWav(res, await storage.readRecordingAudio(req.params.id!));
    });
  });

  router.get('/api/recordings/:id', (req: Request, res: Response) => {
    handleAsync(res, async () => {
      const id = req.params.id!;
      const rec = await storage.getRecording(id);
      if (!rec) {
        // The store answers `undefined` for an unknown id; the HTTP layer is
        // where that becomes the typed 404 envelope (never a 500).
        res.status(404).json({
          code: 'recording-not-found',
          message: `no recording with id "${id}"`,
        });
        return;
      }
      res.status(200).json(rec);
    });
  });

  router.patch('/api/recordings/:id', parseJson, (req: Request, res: Response) => {
    const { label } = (req.body ?? {}) as { label?: unknown };
    if (typeof label !== 'string') {
      sendBadRequest(res, 'invalid-label', 'label must be a string');
      return;
    }
    handleAsync(res, async () => {
      // ONLY the label reaches the store — everything else in the body is
      // ignored on purpose.
      res.status(200).json(await storage.updateRecordingLabel(req.params.id!, label));
    });
  });

  router.delete('/api/recordings/:id', (req: Request, res: Response) => {
    handleAsync(res, async () => {
      // Soft delete. A corpus clip throws `corpus-undeletable` -> 409 and
      // nothing changes.
      res.status(200).json(await storage.deleteRecording(req.params.id!));
    });
  });

  return router;
}
