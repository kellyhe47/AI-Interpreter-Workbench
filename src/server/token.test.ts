/**
 * TDD tests for POST /api/realtime-token (Ticket 005).
 * createTokenRouter's handler is a stub — behavior tests start RED.
 * No supertest: plain fetch against an http server on an ephemeral port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  createTokenRouter,
  DEFAULT_REALTIME_MODEL,
  REALTIME_MODEL_ALLOWLIST,
  REALTIME_TOKEN_PATH,
} from './token';
import type { TokenRouterDeps } from './token';

const cleanups: Array<() => Promise<void> | void> = [];
const savedKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key';
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  vi.restoreAllMocks();
});

async function startApp(deps?: TokenRouterDeps): Promise<string> {
  const app = express();
  app.use(createTokenRouter(deps));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function post(base: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${REALTIME_TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

function okUpstream(json: unknown = { value: 'ek_test_123', expires_at: 1234567890 }) {
  return vi.fn(async () =>
    new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('constants', () => {
  it('locks default model and allowlist', () => {
    expect(DEFAULT_REALTIME_MODEL).toBe('gpt-realtime-mini');
    expect([...REALTIME_MODEL_ALLOWLIST]).toEqual(['gpt-realtime', 'gpt-realtime-mini']);
  });
});

describe(`POST ${REALTIME_TOKEN_PATH}`, () => {
  it('mints a token via the OpenAI client_secrets endpoint (mocked fetch) -> 200 {value}', async () => {
    const fetchImpl = okUpstream();
    const base = await startApp({ fetchImpl });

    const res = await post(base, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { value: string };
    expect(body.value).toBe('ek_test_123');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    const auth =
      headers.Authorization ?? headers.authorization ?? '';
    expect(auth).toBe('Bearer test-key');
    expect(JSON.parse(init.body as string)).toEqual({
      session: {
        type: 'realtime',
        model: 'gpt-realtime-mini', // default model
        audio: { output: { voice: 'alloy' } },
      },
    });
  });

  it('forwards an explicit allowlisted model', async () => {
    const fetchImpl = okUpstream();
    const base = await startApp({ fetchImpl });
    const res = await post(base, { model: 'gpt-realtime' });
    expect(res.status).toBe(200);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).session.model).toBe('gpt-realtime');
  });

  it('rejects a non-allowlisted model with 400 and never calls fetch', async () => {
    const fetchImpl = okUpstream();
    const base = await startApp({ fetchImpl });
    const res = await post(base, { model: 'gpt-4o' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('gpt-4o');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('responds 500 {error} when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchImpl = okUpstream();
    const base = await startApp({ fetchImpl });
    const res = await post(base, {});
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('mirrors upstream failure status with {error}', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'upstream sad' } }), { status: 401 }),
    ) as unknown as typeof fetch;
    const base = await startApp({ fetchImpl });
    const res = await post(base, {});
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: unknown };
    expect(body.error).toBeTruthy();
  });
});
