/**
 * Server wiring tests (Ticket 005): health endpoint intact, token route
 * mounted on the main app, and /ws/cascade attached by createAppServer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { app, createAppServer } from './index';
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
