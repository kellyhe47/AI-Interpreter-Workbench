/**
 * Ticket 008 — STUB. A thin typed client over the ticket-003 REST endpoints.
 *
 * Written test-first: everything below the type declarations throws. The
 * behaviour is pinned by recordingsClient.test.ts.
 *
 * ============================ API DESIGN (normative) =======================
 * `fetch` is INJECTED (deps.fetchImpl), never captured from the global scope,
 * so no test can reach the network. `baseUrl` defaults to '' (same-origin
 * relative paths).
 *
 * FAILURES ARE TYPED (PRD §12). Every non-ok response becomes an `ApiError`
 * carrying the server's `{ code, message }` envelope plus the HTTP status —
 * never a raw `Response` throw, never a bare ENOENT-shaped surprise. Callers
 * key off `code` ('recording-audio-missing' blocks a replay run;
 * 'corpus-undeletable' explains a refused delete).
 * ==========================================================================
 */

import type { Recording, Run } from '../state/ledger';

/** The closed server envelope vocabulary, plus a catch-all for anything else. */
export type ApiErrorCode =
  | 'recording-not-found'
  | 'recording-audio-missing'
  | 'run-audio-missing'
  | 'corpus-undeletable'
  | 'http-error';

/** The typed failure every client method rejects with. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export interface ApiClientDeps {
  /** Injected fetch — the client NEVER touches globalThis.fetch. */
  fetchImpl: typeof fetch;
  /** Origin prefix; defaults to '' (same-origin relative paths). */
  baseUrl?: string;
}

/** POST /api/recordings body — audio rides as base64 in the JSON body. */
export interface NewRecordingInput {
  label: string;
  sourceLanguage: string;
  durationMs: number;
  speechEndMs: number;
  origin: 'mic' | 'corpus';
  createdAt?: number;
  audioBase64: string;
}

export interface RecordingsClient {
  list(): Promise<Recording[]>;
  get(id: string): Promise<Recording>;
  /** The recording's WAV bytes. Rejects ApiError('recording-audio-missing'). */
  getAudio(id: string): Promise<Uint8Array>;
  create(input: NewRecordingInput): Promise<Recording>;
  /** PATCH accepts the label ALONE (audio + metadata are immutable). */
  patchLabel(id: string, label: string): Promise<Recording>;
  /** Soft delete. Rejects ApiError('corpus-undeletable') for a corpus clip. */
  remove(id: string): Promise<Recording>;
}

export interface RunsClient {
  create(run: Run): Promise<Run>;
  list(recordingId?: string): Promise<Run[]>;
  /** The run's output WAV bytes. Rejects ApiError('run-audio-missing'). */
  getAudio(id: string): Promise<Uint8Array>;
}

export function createRecordingsClient(_deps: ApiClientDeps): RecordingsClient {
  throw new Error('not implemented');
}

export function createRunsClient(_deps: ApiClientDeps): RunsClient {
  throw new Error('not implemented');
}
