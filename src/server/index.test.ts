/**
 * Server wiring tests (Ticket 005; extended by Ticket 003).
 *
 * Ticket 005 guards: health endpoint intact, token route mounted on the main
 * app, /ws/cascade attached by createAppServer.
 *
 * ==================== APP FACTORY SEAM (Ticket 003, normative) =============
 * The module-level `app` singleton has no injection seam, so the Recordings /
 * Runs routers could only ever talk to the repo's real `data/` dir. index.ts
 * therefore grows an app factory:
 *
 *   export interface AppDeps {
 *     // Backs /api/recordings and /api/runs. Defaults to createStorage(<repo>/data).
 *     storage?: Storage;
 *     // Directory the production SPA is served from. Defaults to ../../dist/client.
 *     clientDist?: string;
 *   }
 *   export function createApp(deps?: AppDeps): express.Express;
 *   export function createAppServer(deps?: AppDeps): http.Server;
 *   export const app: express.Express;            // === createApp()
 *
 * `createApp` reads process.env.NODE_ENV AT CALL TIME (not at module load), so
 * the production SPA branch is testable. Building the default Storage must not
 * touch the filesystem — createStorage() only closes over paths.
 * ==========================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { app, createApp, createAppServer } from './index';
import { createStorage } from './storage';
import type { Recording, Storage } from './storage';
import { CASCADE_WS_PATH } from './ws';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return (server.address() as AddressInfo).port;
}

/** A Storage over a fresh mkdtemp dir — nothing is ever written into data/. */
async function tempStorage(): Promise<Storage> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-index-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return createStorage(dir);
}

/** A stand-in for dist/client holding a recognisable index.html. */
async function tempClientDist(marker: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-dist-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'index.html'), `<!doctype html><body>${marker}</body>`);
  return dir;
}

function withNodeEnv(value: string): void {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
}

async function postRecording(port: number, label: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/recordings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label,
      sourceLanguage: 'en',
      durationMs: 4200,
      speechEndMs: 3800,
      origin: 'mic',
      audioBase64: Buffer.from(Uint8Array.from([1, 2, 3, 4])).toString('base64'),
    }),
  });
}

describe('server wiring', () => {
  it('AC6: GET /api/health still responds 200 {ok:true}', async () => {
    const port = await listen(http.createServer(app));
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('mounts the token route on the main app (bad model -> 400, no network)', async () => {
    const port = await listen(http.createServer(app));
    const res = await fetch(`http://127.0.0.1:${port}/api/realtime-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'not-a-model' }),
    });
    expect(res.status).toBe(400);
  });

  it('createAppServer attaches the cascade WS endpoint', async () => {
    const port = await listen(createAppServer());

    // health still served by the same server
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);

    // and /ws/cascade upgrades successfully
    const ws = new WebSocket(`ws://127.0.0.1:${port}${CASCADE_WS_PATH}`);
    cleanups.push(() => ws.terminate());
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('Recordings/Runs routers mounted on the app (Ticket 003)', () => {
  it('AC11: createApp({ storage }) serves /api/recordings against the INJECTED storage', async () => {
    const storage = await tempStorage();
    const port = await listen(http.createServer(createApp({ storage })));

    const created = await postRecording(port, 'mounted clip');
    expect(created.status).toBe(201);
    const rec = (await created.json()) as Recording;

    // It really is the injected store, not the repo's data/ dir.
    expect((await storage.getRecording(rec.id))?.label).toBe('mounted clip');

    const list = await fetch(`http://127.0.0.1:${port}/api/recordings`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as Recording[]).map((r) => r.id)).toEqual([rec.id]);

    const runs = await fetch(`http://127.0.0.1:${port}/api/runs`);
    expect(runs.status).toBe(200);
    expect(await runs.json()).toEqual([]);
  });

  it('AC11: the new mounts do not shadow /api/health or the token route', async () => {
    const storage = await tempStorage();
    const port = await listen(http.createServer(createApp({ storage })));

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const token = await fetch(`http://127.0.0.1:${port}/api/realtime-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'not-a-model' }),
    });
    expect(token.status).toBe(400);
  });

  it('createAppServer({ storage }) serves the REST routes AND still attaches /ws/cascade', async () => {
    const storage = await tempStorage();
    const port = await listen(createAppServer({ storage }));

    expect((await postRecording(port, 'via createAppServer')).status).toBe(201);

    const ws = new WebSocket(`ws://127.0.0.1:${port}${CASCADE_WS_PATH}`);
    cleanups.push(() => ws.terminate());
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('production SPA catch-all (Ticket 003)', () => {
  it('AC12: serves index.html for a non-/api path and does NOT intercept /api/recordings', async () => {
    withNodeEnv('production');
    const storage = await tempStorage();
    const clientDist = await tempClientDist('SPA-INDEX-MARKER');
    const port = await listen(http.createServer(createApp({ storage, clientDist })));

    const spa = await fetch(`http://127.0.0.1:${port}/library/recordings`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('SPA-INDEX-MARKER');

    const created = await postRecording(port, 'not swallowed by the SPA');
    expect(created.status).toBe(201);

    const list = await fetch(`http://127.0.0.1:${port}/api/recordings`);
    expect(list.status).toBe(200);
    expect(list.headers.get('content-type')).toContain('application/json');
    const recs = (await list.json()) as Recording[];
    expect(recs.map((r) => r.label)).toEqual(['not swallowed by the SPA']);
  });
});
