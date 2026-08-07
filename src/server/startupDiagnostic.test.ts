/**
 * TICKET 038 — the startup provider-key diagnostic.
 *
 * THE DEFECT: a server started without a provider key starts perfectly happily
 * and says nothing. The first symptom is an opaque failure inside a Live
 * session minutes later — which is exactly how ticket 037's `.env` bug stayed
 * invisible for the whole life of the project under a fully green suite.
 *
 * THE SEAM. `describeProviderKeys(loaded, env)` is PURE: the name set
 * `loadServerEnv` returned goes in, a report comes out, and `index.ts` does
 * nothing but log it. So every rule below is asserted without spawning a
 * process or capturing global stdout.
 *
 * THE LOAD-BEARING TEST is `never leaks a value`: a planted fake secret is put
 * in the environment and the ENTIRE report — every line, every field, JSON and
 * all — is asserted not to contain it, nor any prefix, suffix or length of it.
 * A diagnostic that leaks a key into a log file is worse than no diagnostic.
 *
 * NO REAL SECRETS: every value here is an obvious plant.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './index';
import {
  PROVIDER_KEY_NAMES,
  describeProviderKeys,
  type StartupKeyReport,
} from './env';

/** Obvious plants. Nothing here is or resembles a real credential. */
const FAKE_OPENAI = 'sk-FAKE-ticket038-openai-do-not-use';
const FAKE_ANTHROPIC = 'sk-ant-FAKE-ticket038-anthropic-do-not-use';
const FAKE_ELEVEN = 'FAKE-ticket038-elevenlabs-do-not-use';

/** A non-test NODE_ENV, so the report is not silenced by the test guard. */
const RUNNING: NodeJS.ProcessEnv = { NODE_ENV: 'development' };

/** All three planted, so a fully configured machine can be described too. */
const PLANTED_ALL = {
  OPENAI_API_KEY: FAKE_OPENAI,
  ANTHROPIC_API_KEY: FAKE_ANTHROPIC,
  ELEVENLABS_API_KEY: FAKE_ELEVEN,
};

function report(
  env: NodeJS.ProcessEnv,
  loaded: string[] = [],
): StartupKeyReport {
  return describeProviderKeys(new Set(loaded), env);
}

/** The one line the server logs, or '' when the report is silent. */
function text(r: StartupKeyReport): string {
  return r.lines.join('\n');
}

describe('ticket 038 — PROVIDER_KEY_NAMES is the set the server actually reads', () => {
  it('names the three provider keys, in a stable order', () => {
    expect([...PROVIDER_KEY_NAMES]).toEqual([
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'ELEVENLABS_API_KEY',
    ]);
  });
});

describe('ticket 038 — presence and absence, BY NAME', () => {
  it('reports every key by name with present/absent, in PROVIDER_KEY_NAMES order', () => {
    const r = report(
      { ...RUNNING, OPENAI_API_KEY: FAKE_OPENAI, ANTHROPIC_API_KEY: FAKE_ANTHROPIC },
      ['OPENAI_API_KEY'],
    );

    expect(r.keys).toEqual([
      { name: 'OPENAI_API_KEY', present: true, source: 'dotenv' },
      { name: 'ANTHROPIC_API_KEY', present: true, source: 'environment' },
      { name: 'ELEVENLABS_API_KEY', present: false, source: null },
    ]);
    expect(r.missing).toEqual(['ELEVENLABS_API_KEY']);
  });

  it('the logged line names every key, and says which are absent', () => {
    const line = text(
      report({ ...RUNNING, OPENAI_API_KEY: FAKE_OPENAI, ANTHROPIC_API_KEY: FAKE_ANTHROPIC }, [
        'OPENAI_API_KEY',
      ]),
    );

    for (const name of PROVIDER_KEY_NAMES) expect(line).toContain(name);
    // The absent one is unmistakable, not merely omitted.
    expect(line).toMatch(/ELEVENLABS_API_KEY[^·\n]*absent/i);
  });

  it('AC5: the line distinguishes ".env" from "already in the environment"', () => {
    // Without this a deployment cannot confirm its REAL env vars are the ones
    // in force rather than a stray `.env` sitting beside the build.
    const line = text(
      report({ ...RUNNING, OPENAI_API_KEY: FAKE_OPENAI, ANTHROPIC_API_KEY: FAKE_ANTHROPIC }, [
        'OPENAI_API_KEY',
      ]),
    );

    expect(line).toMatch(/OPENAI_API_KEY present \(from \.env\)/);
    expect(line).toMatch(/ANTHROPIC_API_KEY present \(already in environment\)/);
  });

  it('an empty-string value is ABSENT, not present — a blank .env line is not a key', () => {
    const r = report({ ...RUNNING, OPENAI_API_KEY: '' });

    expect(r.keys[0]).toEqual({ name: 'OPENAI_API_KEY', present: false, source: null });
    expect(r.missing).toContain('OPENAI_API_KEY');
  });

  it('a `loaded` name the server does not use is ignored, and never invented into a key', () => {
    const r = report({ ...RUNNING, SOME_OTHER_THING: 'x' }, ['SOME_OTHER_THING']);

    expect(r.keys.map((k) => k.name)).toEqual([...PROVIDER_KEY_NAMES]);
    expect(text(r)).not.toContain('SOME_OTHER_THING');
  });
});

describe('ticket 038 — NO SECRET EVER REACHES THE REPORT (the load-bearing test)', () => {
  it('no value, prefix, suffix or length of a planted secret appears anywhere in the report', () => {
    const r = report({ ...RUNNING, ...PLANTED_ALL }, ['OPENAI_API_KEY']);
    // EVERYTHING the report carries, not just the rendered line: a field a
    // future caller logs is as dangerous as the line itself.
    const whole = JSON.stringify(r);

    for (const secret of Object.values(PLANTED_ALL)) {
      expect(whole).not.toContain(secret);
      // No prefix and no suffix either — 'sk-FAKE…' redacted to 'sk-FAK*' is
      // still a leak of the part that identifies the account.
      expect(whole).not.toContain(secret.slice(0, 6));
      expect(whole).not.toContain(secret.slice(-6));
      // ...and not its length, which narrows a key more than it looks.
      expect(whole).not.toContain(String(secret.length));
    }
  });
});

describe('ticket 038 — absence is a WARNING, never a failure', () => {
  it('a missing key yields level "warn" and does not throw', () => {
    let r: StartupKeyReport | undefined;
    expect(() => {
      r = report({ ...RUNNING, OPENAI_API_KEY: FAKE_OPENAI, ANTHROPIC_API_KEY: FAKE_ANTHROPIC });
    }).not.toThrow();

    expect(r!.level).toBe('warn');
    expect(r!.missing).toEqual(['ELEVENLABS_API_KEY']);
  });

  it('an environment with NO provider key at all is still a report, not an error', () => {
    // An ElevenLabs-less run is a legitimate configuration; so is a machine
    // that has none of the three. Neither may stop the server.
    const r = report(RUNNING);

    expect(r.level).toBe('warn');
    expect(r.missing).toEqual([...PROVIDER_KEY_NAMES]);
    expect(r.keys.every((k) => k.present === false)).toBe(true);
  });

  it('every key present yields level "info"', () => {
    const r = report({ ...RUNNING, ...PLANTED_ALL });

    expect(r.level).toBe('info');
    expect(r.missing).toEqual([]);
  });
});

describe('ticket 038 — a key-less server still starts and serves', () => {
  const KEYS = [...PROVIDER_KEY_NAMES];
  let saved: Record<string, string | undefined>;
  const servers: http.Server[] = [];

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
  });

  it('with NO provider key in the environment the app is built and answers /api/health', async () => {
    // Absence is a warning, not a hard failure: this must never become a
    // startup gate that refuses to boot an ElevenLabs-less configuration.
    const server = http.createServer(createApp());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('ticket 038 — silent under NODE_ENV=test', () => {
  it('renders NO lines when NODE_ENV is test, however many keys are missing', () => {
    const r = describeProviderKeys(new Set(), { NODE_ENV: 'test' });

    expect(r.lines).toEqual([]);
    // ...but the classification is still computed, so silence is a rendering
    // decision and not a hole in the diagnostic.
    expect(r.missing).toEqual([...PROVIDER_KEY_NAMES]);
    expect(r.level).toBe('warn');
  });

  it('renders exactly one line when NODE_ENV is anything else', () => {
    for (const nodeEnv of ['development', 'production', undefined]) {
      const env: NodeJS.ProcessEnv = nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv };
      expect(describeProviderKeys(new Set(), env).lines).toHaveLength(1);
    }
  });

  it('reads NODE_ENV from the PASSED env, never from the ambient process', () => {
    // The suite itself runs under NODE_ENV=test; a function that consulted
    // process.env directly would be silent here and untestable.
    expect(describeProviderKeys(new Set(), RUNNING).lines).toHaveLength(1);
  });
});

describe('ticket 038 — the default env argument is process.env', () => {
  const SAVED = process.env.ELEVENLABS_API_KEY;

  beforeEach(() => {
    delete process.env.ELEVENLABS_API_KEY;
  });
  afterEach(() => {
    if (SAVED === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = SAVED;
  });

  it('called with only the loaded-name set, it reads process.env', () => {
    process.env.ELEVENLABS_API_KEY = FAKE_ELEVEN;

    const r = describeProviderKeys(new Set(['ELEVENLABS_API_KEY']));

    expect(r.keys.find((k) => k.name === 'ELEVENLABS_API_KEY')).toEqual({
      name: 'ELEVENLABS_API_KEY',
      present: true,
      source: 'dotenv',
    });
    // The suite runs under NODE_ENV=test, so the real process env silences it.
    expect(r.lines).toEqual([]);
  });
});
