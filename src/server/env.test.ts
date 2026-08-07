/**
 * Ticket 037 — the server must load `.env`, or every real provider call fails.
 *
 * The defect this pins: nothing ever loaded `.env`, so
 * `process.env.OPENAI_API_KEY` was undefined on every normal start and
 * `POST /api/realtime-token` answered 500. Live reached
 * "connected · listening" and then failed opaquely, which is exactly what the
 * operator reported.
 *
 * These tests drive `loadServerEnv(file)` against temp files rather than the
 * repo's own `.env`, so they never depend on — or leak — a real key.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadServerEnv } from './env';

let dir: string;
/** Every var these tests touch, restored wholesale afterwards. */
const TOUCHED = ['TICKET_037_A', 'TICKET_037_B', 'TICKET_037_PRESET'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-037-'));
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function writeEnv(contents: string): string {
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

describe('loadServerEnv', () => {
  it('populates process.env from the file — the whole point of the ticket', () => {
    loadServerEnv(writeEnv('TICKET_037_A=from-file\nTICKET_037_B=second\n'));

    expect(process.env.TICKET_037_A).toBe('from-file');
    expect(process.env.TICKET_037_B).toBe('second');
  });

  it('a REAL environment variable wins over the file', () => {
    // Deployment sets real env vars; `.env` is a dev convenience and must never
    // clobber them, or a production secret is silently replaced by a dev one.
    process.env.TICKET_037_PRESET = 'from-real-env';
    loadServerEnv(writeEnv('TICKET_037_PRESET=from-file\n'));

    expect(process.env.TICKET_037_PRESET).toBe('from-real-env');
  });

  it('a MISSING file is not an error — a deployed server has real env vars and no .env', () => {
    expect(() => loadServerEnv(path.join(dir, 'does-not-exist'))).not.toThrow();
  });

  it('a malformed line does not crash startup', () => {
    expect(() =>
      loadServerEnv(writeEnv('this is not a pair\nTICKET_037_A=still-read\n')),
    ).not.toThrow();
  });

  it('returns the names it set, so a caller can log presence WITHOUT logging secrets', () => {
    const loaded = loadServerEnv(writeEnv('TICKET_037_A=x\nTICKET_037_B=y\n'));

    expect([...loaded].sort()).toEqual(['TICKET_037_A', 'TICKET_037_B']);
    // The values must never come back out of this function.
    expect(JSON.stringify(loaded)).not.toContain('x');
  });

  it('reports nothing as loaded when the real environment already had the value', () => {
    process.env.TICKET_037_PRESET = 'from-real-env';
    const loaded = loadServerEnv(writeEnv('TICKET_037_PRESET=from-file\n'));

    expect([...loaded]).toEqual([]);
  });
});
