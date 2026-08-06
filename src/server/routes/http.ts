/**
 * Shared HTTP plumbing for the REST routers (ticket 003).
 *
 * ERRORS ARE A MACHINE-READABLE ENVELOPE (PRD §12): every failure answers
 * `{ code, message }` as `application/json`, where `code` is the
 * `StorageErrorCode` — never a bare status page, never an unhandled throw. The
 * client keys off `code` (an unplayable Recording, a refused corpus delete), so
 * the wording of `message` is free but the code is not.
 *
 *   recording-not-found      -> 404
 *   recording-audio-missing  -> 404
 *   run-audio-missing        -> 404
 *   corpus-undeletable       -> 409
 *
 * The status mapping lives here alone: both routers map the same codes, and a
 * second copy would drift.
 */
import type { Response } from 'express';

import { StorageError } from '../storage';
import type { StorageErrorCode } from '../storage';

/**
 * Base64 audio rides inside the JSON body, so the body limit has to clear a
 * real clip: 1 minute of 24 kHz mono PCM16 is ~2.9 MB raw, ~3.9 MB base64 —
 * far over express's 100 kb default, where a silent 413 would look like a
 * client bug.
 */
export const JSON_BODY_LIMIT = '64mb';

const STATUS_BY_CODE: Record<StorageErrorCode, number> = {
  'recording-not-found': 404,
  'recording-audio-missing': 404,
  'run-audio-missing': 404,
  'corpus-undeletable': 409,
};

/** Send the `{ code, message }` envelope for a typed storage failure. */
export function sendStorageError(res: Response, err: unknown): void {
  if (err instanceof StorageError) {
    res.status(STATUS_BY_CODE[err.code] ?? 500).json({
      code: err.code,
      message: err.message,
    });
    return;
  }
  res.status(500).json({
    code: 'internal-error',
    message: err instanceof Error ? err.message : String(err),
  });
}

/** A malformed request body — 400, distinct from the storage failure codes. */
export function sendBadRequest(res: Response, code: string, message: string): void {
  res.status(400).json({ code, message });
}

/**
 * Run an async handler body safely. Express 4 does not await a handler's
 * returned promise, so the work runs inside `void (async () => {})()` with its
 * own catch — an escaped rejection here would take the process down.
 */
export function handleAsync(res: Response, run: () => Promise<void>): void {
  void (async () => {
    try {
      await run();
    } catch (err) {
      sendStorageError(res, err);
    }
  })();
}

/** 200 + `Content-Type: audio/wav` + the exact bytes. */
export function sendWav(res: Response, bytes: Uint8Array): void {
  res.status(200);
  res.type('audio/wav');
  res.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}
