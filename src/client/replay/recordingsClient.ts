/**
 * Ticket 008 — a thin typed client over the ticket-003 REST endpoints.
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
 *
 * CODE RESOLUTION. The server's envelope wins whenever it names one of the
 * closed vocabulary's codes. Otherwise the per-endpoint fallback applies, but
 * ONLY for the statuses that fallback actually means (404 "the thing or its
 * bytes are gone", 409 "refused"): a 500 from GET /audio is an 'http-error',
 * not a missing recording, and mislabelling it would make the runner tell the
 * operator to re-record a clip that is perfectly fine.
 * ==========================================================================
 */

import type { CorpusUtterance } from '../../core/corpus';
import type { BlindComparison, LiveSession, Recording, Run } from '../state/ledger';

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
  /**
   * TICKET 030/036 — the corpus utterance manifest. Present ONLY on a corpus
   * take; a mic clip must omit the KEY, never send an empty array (which the
   * server reads as "a corpus take with no utterances" and rejects).
   */
  utterances?: CorpusUtterance[];
  /** Provenance for a corpus take; absent on an ad-hoc mic clip. */
  corpusVersion?: string;
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

/**
 * Ticket 023 — the REST seam a submitted blind comparison travels over. PRD §7:
 * the server owns the store; the client reads and writes it over REST. Scores
 * that live only in localStorage are absent from the exported bundle and
 * unreachable from a second machine (QA F6).
 */
export interface BlindComparisonsClient {
  create(comparison: BlindComparison): Promise<BlindComparison>;
  list(recordingId?: string): Promise<BlindComparison[]>;
}

/**
 * TICKET 041 — the REST seam a finished Live session travels over. PRD §7: the
 * server owns the store. PRD §17 19i makes every Live session the stability
 * artifact, and an artifact that exists only in one browser's localStorage
 * cannot reach `data/`, the exported bundle, or a second machine.
 */
export interface LiveSessionsClient {
  create(session: LiveSession): Promise<LiveSession>;
  list(): Promise<LiveSession[]>;
}

const KNOWN_CODES: readonly ApiErrorCode[] = [
  'recording-not-found',
  'recording-audio-missing',
  'run-audio-missing',
  'corpus-undeletable',
  'http-error',
];

/** Statuses for which a per-endpoint fallback code is the honest reading. */
const FALLBACK_STATUSES = new Set([404, 409]);

interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** JSON request body; omitted for GET/DELETE. */
  body?: unknown;
  /** Applied when the envelope names no known code and the status fits. */
  fallback?: ApiErrorCode;
}

/**
 * The server's failure envelope, best-effort. A body that is not the expected
 * `{ code, message }` (an HTML error page, a bare string, a stream that cannot
 * be parsed) must still produce an ApiError — never a raw Response and never a
 * '[object Object]' message.
 */
async function readEnvelope(
  response: Response,
): Promise<{ code?: unknown; message?: unknown } | string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'string') return body;
    if (body !== null && typeof body === 'object') {
      return body as { code?: unknown; message?: unknown };
    }
  } catch {
    // Not JSON (e.g. an audio response that failed) — fall through.
  }
  return null;
}

async function toApiError(response: Response, spec: RequestSpec): Promise<ApiError> {
  const envelope = await readEnvelope(response);
  const enveloped = typeof envelope === 'object' && envelope !== null ? envelope : null;

  const declared = enveloped?.code;
  const code: ApiErrorCode =
    typeof declared === 'string' && (KNOWN_CODES as readonly string[]).includes(declared)
      ? (declared as ApiErrorCode)
      : spec.fallback !== undefined && FALLBACK_STATUSES.has(response.status)
        ? spec.fallback
        : 'http-error';

  const declaredMessage = enveloped?.message;
  const message =
    typeof declaredMessage === 'string' && declaredMessage.length > 0
      ? declaredMessage
      : typeof envelope === 'string' && envelope.length > 0
        ? envelope
        : `HTTP ${response.status}`;

  return new ApiError(code, response.status, message);
}

function createRequester(deps: ApiClientDeps) {
  const baseUrl = deps.baseUrl ?? '';

  async function send(path: string, spec: RequestSpec): Promise<Response> {
    const init: RequestInit =
      spec.body === undefined
        ? { method: spec.method }
        : {
            method: spec.method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(spec.body),
          };
    const response = await deps.fetchImpl(`${baseUrl}${path}`, init);
    if (!response.ok) throw await toApiError(response, spec);
    return response;
  }

  return {
    async json<T>(path: string, spec: RequestSpec): Promise<T> {
      const response = await send(path, spec);
      return (await response.json()) as T;
    },
    async bytes(path: string, spec: RequestSpec): Promise<Uint8Array> {
      const response = await send(path, spec);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

export function createRecordingsClient(deps: ApiClientDeps): RecordingsClient {
  const http = createRequester(deps);

  return {
    list: () => http.json<Recording[]>('/api/recordings', { method: 'GET' }),

    get: (id) =>
      http.json<Recording>(`/api/recordings/${encodeURIComponent(id)}`, {
        method: 'GET',
        fallback: 'recording-not-found',
      }),

    getAudio: (id) =>
      http.bytes(`/api/recordings/${encodeURIComponent(id)}/audio`, {
        method: 'GET',
        fallback: 'recording-audio-missing',
      }),

    create: (input) =>
      http.json<Recording>('/api/recordings', { method: 'POST', body: input }),

    // Label ONLY: the audio and the derived metadata are immutable, because a
    // Recording is the fixed stimulus every Run of it is compared over.
    patchLabel: (id, label) =>
      http.json<Recording>(`/api/recordings/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { label },
        fallback: 'recording-not-found',
      }),

    remove: (id) =>
      http.json<Recording>(`/api/recordings/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        fallback: 'corpus-undeletable',
      }),
  };
}

/**
 * Ticket 023 — the blind-comparisons client.
 *
 * NO per-endpoint `fallback` code is declared. The server's rejection code
 * (`invalid-blind-comparison`) is outside this module's closed vocabulary on
 * purpose: it is a request-shape complaint, not one of the four states a caller
 * branches on, so it surfaces as a plain 'http-error' carrying the server's own
 * `message`. Widening ApiErrorCode for it would make every existing exhaustive
 * `code` switch in the app incomplete for no behavioural gain.
 */
export function createBlindComparisonsClient(deps: ApiClientDeps): BlindComparisonsClient {
  const http = createRequester(deps);

  return {
    create: (comparison) =>
      http.json<BlindComparison>('/api/blind-comparisons', {
        method: 'POST',
        body: comparison,
      }),

    // The unfiltered listing keeps a bare path — an empty query string would
    // be a second URL for the same resource (same rule as createRunsClient).
    list: (recordingId) =>
      http.json<BlindComparison[]>(
        recordingId === undefined
          ? '/api/blind-comparisons'
          : `/api/blind-comparisons?recordingId=${encodeURIComponent(recordingId)}`,
        { method: 'GET' },
      ),
  };
}

/**
 * TICKET 041 — the live-sessions client. STUB.
 *
 * Like the blind-comparisons client it declares NO per-endpoint fallback code:
 * `invalid-live-session` is a request-shape complaint, not one of the four
 * states a caller branches on, so it surfaces as a plain 'http-error' carrying
 * the server's own message.
 */
export function createLiveSessionsClient(_deps: ApiClientDeps): LiveSessionsClient {
  return {
    create: () => Promise.reject(new Error('createLiveSessionsClient: not implemented (041)')),
    list: () => Promise.reject(new Error('createLiveSessionsClient: not implemented (041)')),
  };
}

export function createRunsClient(deps: ApiClientDeps): RunsClient {
  const http = createRequester(deps);

  return {
    create: (run) => http.json<Run>('/api/runs', { method: 'POST', body: run }),

    // The unfiltered listing keeps a bare path — an empty query string would
    // be a second URL for the same resource.
    list: (recordingId) =>
      http.json<Run[]>(
        recordingId === undefined
          ? '/api/runs'
          : `/api/runs?recordingId=${encodeURIComponent(recordingId)}`,
        { method: 'GET' },
      ),

    getAudio: (id) =>
      http.bytes(`/api/runs/${encodeURIComponent(id)}/audio`, {
        method: 'GET',
        fallback: 'run-audio-missing',
      }),
  };
}
