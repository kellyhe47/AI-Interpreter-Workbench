/**
 * Ticket 039 — the cascade WS session.start path must build providers from the
 * MODEL -> (vendor, options) mapping, not from the raw wire string.
 *
 * `ws.ts` used to call `createStt(msg.providers.stt)` with the client's model
 * id and no options, so every real cascade arm died with
 * `Unknown STT provider "gpt-4o-mini-transcribe"`. Fixing only the vendor half
 * would be worse: Arms B and C differ ONLY in the TTS model, so dropping the
 * model makes both arms run the identical pipeline under two labels.
 *
 * These tests capture the constructed CascadeProviders through the injectable
 * orchestrator factory and assert on each adapter's own `config`, which is
 * exactly what would be sent to the vendor. No network: the adapters only read
 * env at construction.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { app } from './index';
import { attachCascadeWs, CASCADE_WS_PATH } from './ws';
import type { OrchestratorFactory } from './ws';
import type { CascadeProviders } from './cascade/orchestrator';
import { ARMS, type ProviderTriple } from '../core/arms';
import type { ServerToClientMessage } from '../core/protocol';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type AnyConfig = Record<string, unknown>;
const cfg = (p: unknown): AnyConfig =>
  (p as { config?: AnyConfig }).config ?? {};

/**
 * Open a socket, send session.start with `providers`, and return whatever the
 * WS layer handed the orchestrator (or the error frame it sent instead).
 */
async function startWith(
  providers: ProviderTriple,
): Promise<{ built?: CascadeProviders; errors: string[] }> {
  let built: CascadeProviders | undefined;
  const capture: OrchestratorFactory = (_source, p) => {
    built = p;
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
  while (built === undefined && errors.length === 0) {
    if (Date.now() > deadline) throw new Error('timed out waiting for session.start handling');
    await new Promise((r) => setTimeout(r, 10));
  }
  return { built, errors };
}

const tripleOf = (tag: 'B' | 'C'): ProviderTriple =>
  ARMS.find((a) => a.tag === tag)!.config.providers!;

describe('session.start builds providers from the resolved model mapping', () => {
  it("Arm B's triple constructs OpenAI STT/MT/TTS with Arm B's models", async () => {
    const { built, errors } = await startWith(tripleOf('B'));
    expect(errors).toEqual([]);
    expect(built).toBeDefined();
    expect(built!.stt.name).toBe('openai');
    expect(built!.mt.name).toBe('openai');
    expect(built!.tts.name).toBe('openai');
    expect(cfg(built!.stt).model).toBe('gpt-4o-transcribe');
    expect(cfg(built!.mt).model).toBe('gpt-4o-mini');
    expect(cfg(built!.tts).model).toBe('gpt-4o-mini-tts');
  });

  it("Arm C's triple reaches ElevenLabs for TTS with modelId carried", async () => {
    const { built, errors } = await startWith(tripleOf('C'));
    expect(errors).toEqual([]);
    expect(built!.stt.name).toBe('openai');
    expect(built!.tts.name).toBe('elevenlabs');
    expect(cfg(built!.tts).modelId).toBe('eleven_flash_v2_5');
  });

  it('a non-default model id (the one the operator hit) no longer errors', async () => {
    const { built, errors } = await startWith({
      stt: 'gpt-4o-mini-transcribe',
      mt: 'claude-haiku-4-5',
      tts: 'eleven_multilingual_v2',
    });
    expect(errors).toEqual([]);
    expect(built!.stt.name).toBe('openai');
    expect(cfg(built!.stt).model).toBe('gpt-4o-mini-transcribe');
    expect(built!.mt.name).toBe('anthropic');
    expect(cfg(built!.mt).model).toBe('claude-haiku-4-5');
    expect(built!.tts.name).toBe('elevenlabs');
    expect(cfg(built!.tts).modelId).toBe('eleven_multilingual_v2');
  });

  /** The anti-collapse assertion, at the layer that actually talks to vendors. */
  it('Arm B and Arm C produce DIFFERENT provider configurations on the wire', async () => {
    const b = await startWith(tripleOf('B'));
    const c = await startWith(tripleOf('C'));
    expect(b.built!.tts.name).not.toBe(c.built!.tts.name);
    expect(cfg(b.built!.tts)).not.toEqual(cfg(c.built!.tts));
    // The stages the arms hold fixed really are held fixed.
    expect(b.built!.stt.name).toBe(c.built!.stt.name);
    expect(cfg(b.built!.stt)).toEqual(cfg(c.built!.stt));
    expect(cfg(b.built!.mt)).toEqual(cfg(c.built!.mt));
  });

  it("fixture mode still works: 'fixture' builds the fixture adapters", async () => {
    const { built, errors } = await startWith({
      stt: 'fixture',
      mt: 'fixture',
      tts: 'fixture',
    });
    expect(errors).toEqual([]);
    expect(built!.stt.name).toBe('fixture');
    expect(built!.mt.name).toBe('fixture');
    expect(built!.tts.name).toBe('fixture');
  });

  it('an unknown model still fails loudly, naming it, with the socket kept open', async () => {
    const { built, errors } = await startWith({
      stt: 'gpt-9-imaginary',
      mt: 'gpt-4o-mini',
      tts: 'gpt-4o-mini-tts',
    });
    expect(built).toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toContain('gpt-9-imaginary');
  });
});
