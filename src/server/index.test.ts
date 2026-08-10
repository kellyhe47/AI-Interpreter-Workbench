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
import { fileURLToPath } from 'node:url';
import { app, createApp, createAppServer, resolveApiPort } from './index';
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

/**
 * ==================== API PORT RESOLUTION (Ticket 021, normative) ==========
 * QA F4: `preview_start`ing the repo's own `workbench` launch config exports
 * PORT=5173 (the *Vite* port). `npm run dev` then starts the API with
 * `Number(process.env.PORT ?? 8787)`, so the API binds 5173, never 8787 — and
 * every proxied /api call is ECONNREFUSED.
 *
 * index.ts therefore grows a pure, env-in/number-out resolver that the
 * module-level listener calls:
 *
 *   export function resolveApiPort(env?: NodeJS.ProcessEnv): number;
 *
 * PINNED PRECEDENCE: `API_PORT` when set, otherwise the 8787 default. A
 * generic `PORT` is NEVER consulted — it belongs to the client dev server.
 * The default must equal what vite.config.ts proxies to; the test below reads
 * BOTH sources rather than hardcoding 8787 twice.
 *
 * The `createAppServer(deps?)` factory keeps its own separate concern: tests
 * listen(0) on an ephemeral port and never touch the environment.
 * ==========================================================================
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function readRepoFile(rel: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, rel), 'utf8');
}

/**
 * Pull the proxy target port for a route out of vite.config.ts source, so the
 * agreement assertion reads the real config instead of restating a literal.
 * Handles both shorthand (`'/api': 'http://…'`) and object (`{ target: … }`).
 */
function viteProxyTargetPort(source: string, route: string): number {
  const escaped = route.replace(/\//g, '\\/');
  const shorthand = new RegExp(`['"]${escaped}['"]\\s*:\\s*['"]([^'"]+)['"]`).exec(source);
  const object = new RegExp(
    `['"]${escaped}['"]\\s*:\\s*\\{[^}]*target\\s*:\\s*['"]([^'"]+)['"]`,
    's',
  ).exec(source);
  const target = shorthand?.[1] ?? object?.[1];
  if (!target) throw new Error(`no proxy target for ${route} found in vite.config.ts`);
  const port = Number(new URL(target).port);
  if (!Number.isInteger(port) || port === 0) {
    throw new Error(`proxy target for ${route} has no explicit port: ${target}`);
  }
  return port;
}

describe('API port resolution (Ticket 021)', () => {
  it('AC1/AC3: defaults to 8787 with an empty environment', () => {
    expect(resolveApiPort({})).toBe(8787);
  });

  it('AC1: PORT=5173 (the Vite port) does NOT move the API off its own port', () => {
    expect(resolveApiPort({ PORT: '5173' })).toBe(8787);
  });

  it('AC2: a deliberate API_PORT override still works', () => {
    expect(resolveApiPort({ API_PORT: '9000' })).toBe(9000);
  });

  it('AC2: API_PORT wins and PORT is never consulted', () => {
    expect(resolveApiPort({ API_PORT: '9000', PORT: '5173' })).toBe(9000);
  });

  it('AC3: the default agrees with every port vite.config.ts proxies to', async () => {
    const viteConfig = await readRepoFile('vite.config.ts');
    const defaultPort = resolveApiPort({});

    expect(viteProxyTargetPort(viteConfig, '/api')).toBe(defaultPort);
    expect(viteProxyTargetPort(viteConfig, '/ws')).toBe(defaultPort);
  });

  it('AC1: the module-level listener resolves its port via resolveApiPort, not process.env.PORT', async () => {
    const source = await readRepoFile('src/server/index.ts');

    // Two occurrences: the declaration (or its import) and the call site in
    // the module-level listener block. One alone means it is dead code.
    const uses = source.match(/\bresolveApiPort\b/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    // The resolver stays pure: the generic PORT is only ever reached through
    // the injected `env` parameter, never off the global process. (Ticket 071
    // lifted the blanket ban on consulting PORT at all — the behavioural
    // precedence tests below are what pin when it may be read.)
    expect(source).not.toMatch(/process\.env\.PORT\b/);
  });
});

/**
 * ============ PaaS PORT INJECTION (Ticket 071, normative) ==================
 * Railway/Heroku/Render/Fly inject the generic `PORT` and route platform
 * traffic to it. Ticket 021's blanket refusal to read `PORT` therefore made
 * `npm start` bind 8787 while the platform routed to $PORT — a green build
 * that answers 502 forever.
 *
 * The fix is NOT "read PORT". Reading it unconditionally reintroduces QA F4:
 * the repo's `workbench` preview config exports the *Vite* port 5173 into the
 * environment shared by both halves of `npm run dev`, so the API would bind
 * 5173 while vite.config.ts proxies /api and /ws to 8787.
 *
 * PINNED PRECEDENCE (all three tiers):
 *   1. `API_PORT`  — always wins, in production and out.
 *   2. `PORT`      — consulted ONLY when NODE_ENV === 'production', which
 *                    `npm start` sets and `npm run dev` does not.
 *   3. otherwise   — DEFAULT_API_PORT (8787), the vite proxy target.
 *
 * A malformed value is validated by the SAME rule for both variables — one
 * rule, not two.
 * ==========================================================================
 */
describe('API port resolution honours a PaaS-injected PORT in production (Ticket 071)', () => {
  it('AC1: in production, PORT is honoured when API_PORT is absent', () => {
    expect(resolveApiPort({ NODE_ENV: 'production', PORT: '7391' })).toBe(7391);
  });

  it('AC2: API_PORT still wins over PORT in production', () => {
    expect(resolveApiPort({ NODE_ENV: 'production', API_PORT: '9000', PORT: '7391' })).toBe(9000);
  });

  it('AC2: API_PORT still wins over PORT outside production', () => {
    expect(resolveApiPort({ API_PORT: '9000', PORT: '7391' })).toBe(9000);
  });

  it('AC3 (QA F4 guard): PORT is ignored when NODE_ENV is unset', () => {
    expect(resolveApiPort({ PORT: '5173' })).toBe(8787);
  });

  it('AC3 (QA F4 guard): PORT is ignored when NODE_ENV=development', () => {
    expect(resolveApiPort({ NODE_ENV: 'development', PORT: '5173' })).toBe(8787);
  });

  it('AC3 (QA F4 guard): PORT is ignored under NODE_ENV=test', () => {
    expect(resolveApiPort({ NODE_ENV: 'test', PORT: '5173' })).toBe(8787);
  });

  it('AC3: production still defaults to 8787 when neither variable is set', () => {
    expect(resolveApiPort({ NODE_ENV: 'production' })).toBe(8787);
  });

  it('AC4: a malformed production PORT falls back to the default', () => {
    for (const bad of ['', '   ', 'abc', '0', '-1', '8787.5', '65536', 'NaN', '80 80']) {
      expect(resolveApiPort({ NODE_ENV: 'production', PORT: bad })).toBe(8787);
    }
  });

  it('AC4: a malformed value is rejected identically for API_PORT and PORT — one rule, not two', () => {
    for (const bad of ['', '   ', 'abc', '0', '-1', '8787.5', '65536', 'NaN', '80 80']) {
      expect(resolveApiPort({ NODE_ENV: 'production', API_PORT: bad })).toBe(
        resolveApiPort({ NODE_ENV: 'production', PORT: bad }),
      );
      expect(resolveApiPort({ NODE_ENV: 'production', API_PORT: bad })).toBe(8787);
    }
    // ...and a well-formed value is accepted identically by both.
    for (const good of ['1', '7391', '65535']) {
      expect(resolveApiPort({ NODE_ENV: 'production', API_PORT: good })).toBe(Number(good));
      expect(resolveApiPort({ NODE_ENV: 'production', PORT: good })).toBe(Number(good));
    }
  });

  it('AC4: a malformed API_PORT does NOT fall through to PORT in production', () => {
    // API_PORT is present-but-broken: that is an operator mistake about the
    // API's own port, not an invitation to bind whatever the platform set.
    expect(resolveApiPort({ NODE_ENV: 'production', API_PORT: 'abc', PORT: '7391' })).toBe(8787);
  });
});

describe('runtime dependencies resolve without devDependencies (Ticket 071)', () => {
  it('AC5: tsx is a runtime dependency — `npm start` runs it after a dev-dep prune', async () => {
    const pkg = JSON.parse(await readRepoFile('package.json')) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(pkg.scripts.start).toContain('tsx');
    expect(pkg.dependencies).toHaveProperty('tsx');
    expect(pkg.devDependencies).not.toHaveProperty('tsx');
  });

  it('AC5: every external package the server entry imports is in dependencies', async () => {
    const pkg = JSON.parse(await readRepoFile('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    // Walk the real import graph of the server entry rather than trusting a list.
    const seen = new Set<string>();
    const external = new Set<string>();
    const visit = async (absPath: string): Promise<void> => {
      if (seen.has(absPath)) return;
      seen.add(absPath);
      const source = await fs.readFile(absPath, 'utf8');
      for (const m of source.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1] ?? '';
        if (spec === '' || spec.startsWith('node:')) continue;
        if (!spec.startsWith('.')) {
          const parts = spec.split('/');
          external.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec));
          continue;
        }
        const base = path.resolve(path.dirname(absPath), spec);
        const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];
        for (const candidate of candidates) {
          try {
            await fs.access(candidate);
            await visit(candidate);
            break;
          } catch {
            /* try the next candidate */
          }
        }
      }
    };
    await visit(path.join(repoRoot, 'src/server/index.ts'));

    expect(external.size).toBeGreaterThan(0);
    for (const dep of external) {
      expect(
        Object.prototype.hasOwnProperty.call(pkg.dependencies, dep),
        `${dep} is imported by the server entry graph but is not in dependencies`,
      ).toBe(true);
    }
  });

  it('AC6: engines.node is declared and matches the major version in use', async () => {
    const pkg = JSON.parse(await readRepoFile('package.json')) as {
      engines?: { node?: string };
    };

    expect(pkg.engines?.node).toBeTruthy();
    const declaredMajor = Number(/(\d+)/.exec(pkg.engines?.node ?? '')?.[1]);
    const runningMajor = Number(process.versions.node.split('.')[0]);
    expect(declaredMajor).toBe(runningMajor);
  });
});

describe('dev/prod wiring unchanged (Ticket 021 regression guard)', () => {
  it('AC4: `npm run dev` still starts BOTH the server and the client', async () => {
    const pkg = JSON.parse(await readRepoFile('package.json')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts.dev).toContain('npm run dev:server');
    expect(pkg.scripts.dev).toContain('npm run dev:client');
    expect(pkg.scripts['dev:server']).toContain('src/server/index.ts');
    expect(pkg.scripts['dev:client']).toContain('vite');
  });

  it('AC4: the production `start` script still runs the server entry in production mode', async () => {
    const pkg = JSON.parse(await readRepoFile('package.json')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts.start).toContain('NODE_ENV=production');
    expect(pkg.scripts.start).toContain('src/server/index.ts');
  });

  it('AC4: createAppServer() still serves on an ephemeral port, untouched by the environment', async () => {
    const storage = await tempStorage();
    const port = await listen(createAppServer({ storage }));

    expect(port).not.toBe(8787);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
