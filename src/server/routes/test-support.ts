/**
 * Test-only helpers for the REST route suite (ticket 003).
 *
 * Every harness gets a fresh `mkdtemp` base directory and an injected
 * `Storage` pointed at it, so no test ever writes into the repo's `data/`.
 */
import express from 'express';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createStorage } from '../storage';
import type { Recording, Run, Storage } from '../storage';
import { createRecordingsRouter } from './recordings';
import { createRunsRouter } from './runs';

export interface ApiHarness {
  /** Origin of the running test server, e.g. http://127.0.0.1:54321 */
  base: string;
  /** The very Storage the routers were built with — inspect it directly. */
  storage: Storage;
  /** The mkdtemp base directory backing `storage`. */
  dir: string;
  close(): Promise<void>;
}

/**
 * Boot a bare express app carrying ONLY the two new routers, over a temp-dir
 * Storage. Deliberately not the full app: mounting into src/server/index.ts is
 * pinned separately by src/server/index.test.ts.
 */
export async function startApi(): Promise<ApiHarness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-routes-'));
  const storage = createStorage(dir);

  const app = express();
  app.use(createRecordingsRouter({ storage }));
  app.use(createRunsRouter({ storage }));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    storage,
    dir,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** Deterministic pseudo-WAV bytes — the routes treat them as opaque. */
export function wavBytes(seed = 1, length = 64): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (seed * 37 + i * 13) % 256;
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export interface RecordingUploadOverrides {
  label?: string;
  sourceLanguage?: string;
  durationMs?: number;
  speechEndMs?: number;
  origin?: 'mic' | 'corpus';
  audio?: Uint8Array;
}

/**
 * POST /api/recordings in the pinned wire format: a JSON body whose `audioBase64`
 * field carries the WAV bytes alongside the metadata.
 */
export async function postRecording(
  api: ApiHarness,
  overrides: RecordingUploadOverrides = {},
): Promise<Response> {
  const { audio = wavBytes(), ...meta } = overrides;
  return fetch(`${api.base}/api/recordings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label: 'clip one',
      sourceLanguage: 'en',
      durationMs: 4200,
      speechEndMs: 3800,
      origin: 'mic',
      ...meta,
      audioBase64: toBase64(audio),
    }),
  });
}

/** POST a Recording and return the created record, failing loudly on non-201. */
export async function createRecording(
  api: ApiHarness,
  overrides: RecordingUploadOverrides = {},
): Promise<Recording> {
  const res = await postRecording(api, overrides);
  if (res.status !== 201) {
    throw new Error(`POST /api/recordings -> ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as Recording;
}

export async function postRun(api: ApiHarness, run: Run): Promise<Response> {
  return fetch(`${api.base}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run),
  });
}

export async function bodyBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

/** Parse a JSON error envelope: `{ code, message }`. */
export async function errorBody(res: Response): Promise<{ code?: string; message?: string }> {
  return (await res.json()) as { code?: string; message?: string };
}
