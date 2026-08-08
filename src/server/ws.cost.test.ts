/**
 * TICKET 052 ROUND 2 — R2-2, the WIRING SEAM.
 *
 * `ws.ts` forwards `models: msg.providers` into `RunCascadeOptions`, and that
 * one line is what lets the cost model pick a rate card per stage. Changing it
 * to `models: undefined` left 2014/2014 tests green — the
 * wiring-seam-delivered-incidentally pattern: load-bearing for every cascade
 * price this project will ever report, and pinned by nothing.
 *
 * WHY A VENDOR NAME CANNOT SUBSTITUTE. The registry is keyed by VENDOR, so
 * `provider.name` is `'openai'` or `'elevenlabs'`. `gpt-4o-mini-tts` and
 * `eleven_flash_v2_5` are both reachable under those names and they bill on
 * DIFFERENT METERS — tokens against characters-with-a-1k-floor. Arm B and Arm C
 * differ in that stage alone, which is the whole of Experiment 2, so a triple
 * that arrives as vendor names prices both arms identically or not at all.
 *
 * These tests capture what the WS layer actually handed the orchestrator,
 * through the same injectable factory `ws.providers.test.ts` uses.
 */

import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';

import { app } from './index';
import { CASCADE_WS_PATH, attachCascadeWs } from './ws';
import type { OrchestratorFactory } from './ws';
import type { RunCascadeOptions } from './cascade/orchestrator';
import { ARMS, type ProviderTriple } from '../core/arms';
import { rateFor } from '../core/pricing';
import type { ServerToClientMessage } from '../core/protocol';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Open a socket, send session.start, return the OPTIONS the orchestrator got. */
async function optionsFor(providers: ProviderTriple): Promise<RunCascadeOptions | undefined> {
  let seen: RunCascadeOptions | undefined;
  let called = false;
  const capture: OrchestratorFactory = (_source, _p, opts) => {
    seen = opts;
    called = true;
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return (async function* () {})();
  };

  const server = http.createServer(app);
  attachCascadeWs(server, { createOrchestrator: capture });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const ws = new WebSocket(`ws://127.0.0.1:${port}${CASCADE_WS_PATH}`);
  const errors: string[] = [];
  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString('utf8')) as ServerToClientMessage;
    if (msg.type === 'error') errors.push(msg.message);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  cleanups.push(() => ws.terminate());

  ws.send(
    JSON.stringify({
      type: 'session.start',
      mode: 'cascade',
      languagePair: 'en-es',
      direction: 'en->es',
      providers,
    }),
  );

  const deadline = Date.now() + 4000;
  while (!called && errors.length === 0) {
    if (Date.now() > deadline) throw new Error('timed out waiting for session.start handling');
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(errors).toEqual([]);
  return seen;
}

const tripleOf = (tag: 'B' | 'C'): ProviderTriple => ARMS.find((a) => a.tag === tag)!.config.providers!;

describe('R2-2 · session.start forwards the MODEL ids the cost model prices on', () => {
  it("hands Arm B's triple to the orchestrator verbatim", async () => {
    const opts = await optionsFor(tripleOf('B'));
    expect(opts?.models).toEqual(tripleOf('B'));
  });

  it("hands Arm C's triple through, TTS model and all", async () => {
    // The stage the two arms differ in is the one that must survive the trip.
    const opts = await optionsFor(tripleOf('C'));
    expect(opts?.models?.tts).toBe('eleven_flash_v2_5');
  });

  it('forwards ids the RATE CARD can actually price, not vendor names', async () => {
    // `'openai'` and `'elevenlabs'` are not in the card; the arm models are.
    // This is the assertion that fails the moment someone forwards
    // `provider.name` instead of the wire triple.
    const opts = await optionsFor(tripleOf('C'));
    const models = opts!.models!;
    expect(rateFor(models.stt)).toBeDefined();
    expect(rateFor(models.tts)).toBeDefined();
    expect(rateFor('openai')).toBeUndefined();
    expect(rateFor('elevenlabs')).toBeUndefined();
  });

  it('Arm B and Arm C reach the cost model on DIFFERENT meters', async () => {
    // Experiment 2's entire question, at the wiring seam. If both arms arrive
    // under one meter, no cost difference can be attributed to the TTS swap.
    const b = await optionsFor(tripleOf('B'));
    const c = await optionsFor(tripleOf('C'));
    expect(b!.models!.tts).not.toBe(c!.models!.tts);
    expect(rateFor(b!.models!.tts)!.shape).toBe('token');
    expect(rateFor(c!.models!.tts)!.shape).toBe('per-character');
    // ...and the stages the arms hold fixed really do arrive identical.
    expect(b!.models!.stt).toBe(c!.models!.stt);
    expect(b!.models!.mt).toBe(c!.models!.mt);
  });
});
