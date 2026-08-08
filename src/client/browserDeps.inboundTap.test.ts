/**
 * Ticket 046 — WHERE the inbound tap is wired, and where it must NOT be.
 *
 * `browserDeps.ts` is deliberately untested elsewhere: it is the one module made
 * entirely of real browser objects. But this ticket's failure mode is a WIRING
 * one in both directions —
 *
 *   - a tap absent from `buildReplayDeps` means Arm A still captures nothing and
 *     every unit below it passes while the product is unchanged (a seam nothing
 *     wires is a seam that does not exist);
 *   - a tap present in `buildBrowserDeps` means LIVE starts storing audio, which
 *     it must never do (§17 19h). Live plays the model's track through the
 *     ticket-040 `remoteAudioSink` and persists nothing at all.
 *
 * ============================ ROUND 2 ======================================
 * R2-1 (BLOCKER). The previous version of this file split the module SOURCE on
 * `export function buildBrowserDeps` and asserted the first half contained the
 * string `createInboundAudioTap` — which the IMPORT LINE alone satisfies. The
 * reviewer deleted the entire property from `buildReplayDeps` and the suite
 * stayed 1726/1726 green; there is no lint script to catch the orphaned import.
 * So the Replay wiring is now asserted on the CONSTRUCTED TRANSPORT, exactly as
 * the Live half always did, through `ReplayDeps.createTransport` — the factory
 * `runOnce` is bound to.
 *
 * R2-3 (MAJOR). `buildReplayDeps` wired NO `remoteAudioSink`, so the remote
 * MediaStream went straight into `createMediaStreamSource`. Chromium has a long
 * history of delivering SILENCE from a remote WebRTC stream into Web Audio
 * unless the stream is ALSO sunk to a media element. The decision is to reuse
 * the seam that already exists rather than add a second one: Replay gets a
 * MUTED `remoteAudioSink`. Muted keeps the stream pulled while producing no
 * sound at all, which is what "nothing autoplays in Replay" (PRD §7) protects.
 * ==========================================================================
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL } from '../core/arms';
import { buildBrowserDeps, buildReplayDeps } from './browserDeps';
import type { RunOnceConfig } from './replay/runner';
import type { RealtimeDeps, RemoteAudioSink, RtcMediaStreamLike } from './transport/realtime';
import type { InterpreterTransport } from './transport/types';
import type { LiveRunConfig } from './views/useSessionController';

const SOURCE = readFileSync(resolve(process.cwd(), 'src/client/browserDeps.ts'), 'utf8');

/** Just the body of `buildReplayDeps` — never "the first half of the file". */
const REPLAY_DEPS_SOURCE = SOURCE.slice(
  SOURCE.indexOf('export function buildReplayDeps'),
  SOURCE.indexOf('export function buildBrowserDeps'),
);

/** The realtime transport's injected deps bag, read off the instance. */
function realtimeDepsOf(transport: unknown): RealtimeDeps {
  return (transport as { deps: RealtimeDeps }).deps;
}

const LIVE_REALTIME: LiveRunConfig = {
  architecture: 'realtime',
  realtimeModel: 'gpt-realtime-mini',
  contextPolicy: 'default',
};

const REPLAY_REALTIME: RunOnceConfig = {
  architecture: 'realtime',
  realtimeModel: REALTIME_MODEL,
  languagePair: 'EN↔ES',
  direction: 'en→es',
  targetLanguage: 'Spanish',
};

const REPLAY_CASCADE: RunOnceConfig = {
  architecture: 'cascade',
  providers: DEFAULT_CASCADE_TRIPLE,
  languagePair: 'EN↔ES',
  direction: 'en→es',
  targetLanguage: 'Spanish',
};

/**
 * The Replay transport factory, read off the CONSTRUCTED bag. This is the seam
 * R2-1 exists for: `buildReplayDeps` must publish the very factory it binds into
 * `runOnce`, because a source-text assertion cannot tell a wired property from
 * an unused import.
 */
function replayTransportFactory(): (config: RunOnceConfig) => InterpreterTransport {
  const deps = buildReplayDeps();
  const factory = deps.createTransport;
  if (typeof factory !== 'function') {
    throw new Error(
      'buildReplayDeps() published no createTransport — the Replay transport wiring ' +
        '(inbound tap, outbound sink, muted remote sink) is unassertable without it',
    );
  }
  return factory;
}

/** Every hidden media element the sinks under test created, in DOM order. */
const audioElements = (): HTMLAudioElement[] =>
  Array.from(document.querySelectorAll('audio')) as HTMLAudioElement[];

const fakeStream = (tag: string): RtcMediaStreamLike & { tag: string } => ({
  tag,
  getAudioTracks: () => [{ kind: 'audio' }],
});

/** The one element a sink creates on its first attach. */
function attachAndReadElement(sink: RemoteAudioSink, tag: string): HTMLAudioElement {
  expect(audioElements()).toHaveLength(0);
  sink.attach(fakeStream(tag));
  const elements = audioElements();
  expect(elements).toHaveLength(1);
  return elements[0]!;
}

beforeEach(() => {
  // The sinks append a hidden <audio> to document.body on first use, and jsdom's
  // document survives between tests in a file.
  document.body.innerHTML = '';
});

describe('browserDeps — the inbound tap is REPLAY ONLY (ticket 046)', () => {
  it('the REPLAY realtime transport is CONSTRUCTED with createInboundAudioTap (R2-1)', () => {
    const bag = realtimeDepsOf(replayTransportFactory()(REPLAY_REALTIME));

    // The property on the built object, not a string in the file.
    expect(typeof bag.createInboundAudioTap).toBe('function');
    // ...and its siblings, so a factory that half-wired Replay is caught here
    // rather than in a browser.
    expect(typeof bag.createOutboundAudioSink).toBe('function');
    // Replay has NO microphone: the clip is paced in through `sendAudio`.
    expect(bag.getMediaStream).toBeUndefined();
  });

  it('a CASCADE config gets no tap at all — cascade audio already arrives on onAudio', () => {
    const transport = replayTransportFactory()(REPLAY_CASCADE);
    expect(transport.kind).toBe('cascade');
    const bag = (transport as unknown as { deps: Record<string, unknown> }).deps;
    expect(bag.createInboundAudioTap).toBeUndefined();
    expect(bag.remoteAudioSink).toBeUndefined();
  });

  it('the tap comes from the production module, wired as a property of the realtime branch', () => {
    // A belt to R2-1's braces, SCOPED TO THE FUNCTION BODY: the reviewer's
    // mutation deleted exactly this property.
    expect(REPLAY_DEPS_SOURCE).toMatch(/createInboundAudioTap:\s*\(\)\s*=>/);
    expect(SOURCE.includes("from './audio/inboundAudio'")).toBe(true);
  });

  it('REGRESSION GUARD: the LIVE transport factory wires NO tap — Live persists no audio at all', () => {
    const liveHalf = SOURCE.split('export function buildBrowserDeps')[1]!;
    expect(liveHalf.includes('createInboundAudioTap')).toBe(false);

    // ...and the built bag agrees: playback yes, capture no, outbound no.
    const deps = buildBrowserDeps();
    const bag = realtimeDepsOf(deps.transportFactory(LIVE_REALTIME));
    expect(bag.remoteAudioSink).toBeDefined();
    expect(bag.createInboundAudioTap).toBeUndefined();
    expect(bag.createOutboundAudioSink).toBeUndefined();
    expect(bag.getMediaStream).toBeDefined();
  });
});

/* ===========================================================================
 * R2-3 — Replay sinks the remote stream to a MUTED element.
 * ======================================================================== */

describe('browserDeps — Replay’s remote sink is MUTED, not absent (round 2, R2-3)', () => {
  it('the Replay realtime transport carries a remoteAudioSink', () => {
    // Without one, the remote MediaStream reaches Web Audio and nothing else,
    // and Chromium is entitled to hand `createMediaStreamSource` pure silence —
    // Arm A would upload a file of zeros that passes every format assertion.
    const bag = realtimeDepsOf(replayTransportFactory()(REPLAY_REALTIME));
    expect(bag.remoteAudioSink).toBeDefined();
  });

  it('its element is MUTED, so Replay still produces NO audible output (PRD §7)', () => {
    const bag = realtimeDepsOf(replayTransportFactory()(REPLAY_REALTIME));
    const stream = fakeStream('remote');

    expect(audioElements()).toHaveLength(0);
    bag.remoteAudioSink!.attach(stream);

    const elements = audioElements();
    expect(elements).toHaveLength(1);
    const el = elements[0]!;
    // MUTED is the whole decision: the stream is pulled (so Web Audio receives
    // real samples) while nothing is sounded.
    expect(el.muted).toBe(true);
    // ...and it really is sunk — a element with no source pulls nothing.
    expect((el as unknown as { srcObject: unknown }).srcObject).toBe(stream);
    // Not an operator surface either: Replay has no play/pause for this.
    expect(el.controls).toBe(false);
  });

  it('attach/play/pause are jsdom-safe — jsdom’s play() returns undefined, not a promise', () => {
    // The production sink does `node.play?.().catch(...)`, which THROWS in jsdom
    // because `play()` there returns undefined. A seam this file cannot call is
    // a seam this file cannot pin.
    const bag = realtimeDepsOf(replayTransportFactory()(REPLAY_REALTIME));
    const sink = bag.remoteAudioSink!;
    expect(() => sink.attach(fakeStream('remote'))).not.toThrow();
    expect(() => sink.play()).not.toThrow();
    expect(() => sink.pause()).not.toThrow();
    expect(audioElements()).toHaveLength(1);
    expect(audioElements()[0]!.muted).toBe(true);
  });

  it('LIVE’s sink is the AUDIBLE one — muting Replay must not mute the operator', () => {
    const deps = buildBrowserDeps();
    const el = attachAndReadElement(deps.remoteAudioSink!, 'live-remote');
    expect(el.muted).toBe(false);
    expect(el.autoplay).toBe(true);
  });
});
