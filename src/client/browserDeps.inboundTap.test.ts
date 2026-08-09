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
 * ============================ ROUND 3 ======================================
 * F1 (P0). The same hole, one property along. `selectionStore:
 * browserSelectionStore()` (browserDeps.ts) is the ONLY line that makes ticket
 * 066's Recording selection survive a RELOAD, and deleting it left the whole
 * suite green and both typechecks clean — because `App` supplies an in-memory
 * fallback that carries the selection across a TAB change, so every existing
 * 066 test passes with the real store gone. The two guards R2-1 established are
 * therefore extended to it: a property probe off the CONSTRUCTED bag, and a
 * source scan SCOPED to `buildReplayDeps`' body. Plus the store's own three
 * behaviours, which nothing exercised at all: the defensive try/catch, the
 * empty-string coercion, and `removeItem` on a cleared selection.
 * ==========================================================================
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('the PUBLISHED factory is the one runOnce is BOUND to (round 3, R3-5)', () => {
    // R2-1 pins the factory the bag PUBLISHES. It cannot pin that `runOnce` uses
    // that same factory: verified, publishing the correctly-wired one while
    // binding `runnerDeps.createTransport` to a second, UNWIRED factory left the
    // whole suite green. Nothing observable distinguishes them from outside —
    // `runOnce` builds a real transport and would need a real network — so this
    // is a SOURCE-TEXT assertion by necessity, and is labelled as such.
    //
    // Both sites must reference the ONE `const createTransport`, by shorthand:
    // a second arrow function at either site fails this.
    expect(REPLAY_DEPS_SOURCE).toMatch(
      /const runnerDeps: RunnerDeps = \{[^}]*\bcreateTransport,/s,
    );
    // ...and the bag publishes the same binding, not a copy of the wiring.
    expect(REPLAY_DEPS_SOURCE).toMatch(/const createTransport = \(config: RunOnceConfig\)/);
    // Exactly ONE transport factory is declared in this function.
    expect(REPLAY_DEPS_SOURCE.match(/const createTransport\b/g)).toHaveLength(1);
    // `startBatch` runs through the SAME runnerDeps, so a sweep and a single run
    // cannot end up on different wiring.
    expect(REPLAY_DEPS_SOURCE).toMatch(/createRunOnceExecutor\(runnerDeps\)/);
    expect(REPLAY_DEPS_SOURCE).toMatch(/deps: runnerDeps/);
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
    // Non-optional on BrowserDeps since ticket 047 moved it off SessionDeps:
    // the browser bag ALWAYS builds one, so there is nothing to assert away.
    const el = attachAndReadElement(deps.remoteAudioSink, 'live-remote');
    expect(el.muted).toBe(false);
    expect(el.autoplay).toBe(true);
  });
});


/* ===========================================================================
 * ROUND 3 F1 — the ticket-066 selection store is WIRED, and it is a REAL one.
 *
 * The same two-way guard R2-1 established for the inbound tap, because it is
 * the same failure: `selectionStore: browserSelectionStore()` was deletable
 * with 2383/2383 green. The honest target is the RELOAD — App's in-memory
 * fallback already carries the selection across a tab change, so a tab
 * round-trip cannot tell a wired store from a missing one. A second
 * `buildReplayDeps()` IS the reload: a fresh bag over the same browser storage.
 *
 * WHY THE STORAGE IS INSTALLED HERE. This runner is Node 22 under jsdom, and
 * Node's own `localStorage` global shadows jsdom's and is undefined without
 * `--localstorage-file` — so `window.localStorage` is ABSENT in every test in
 * this repo. The production store's try/catch swallows that, which means an
 * uninstalled run would pass every assertion below for the wrong reason. So the
 * Storage is supplied explicitly, exactly as a browser supplies it, and the
 * module under test still reaches for it by the global name it uses in
 * production.
 * ======================================================================== */

/** A real-shaped Storage, with individual methods replaceable. */
function installStorage(overrides: Partial<Storage> = {}): Map<string, string> {
  const entries = new Map<string, string>();
  const storage = {
    get length(): number {
      return entries.size;
    },
    key: (index: number): string | null => Array.from(entries.keys())[index] ?? null,
    getItem: (key: string): string | null => entries.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      entries.set(key, String(value));
    },
    removeItem: (key: string): void => {
      entries.delete(key);
    },
    clear: (): void => entries.clear(),
    ...overrides,
  };
  Object.defineProperty(window, 'localStorage', {
    value: storage as unknown as Storage,
    configurable: true,
    writable: true,
  });
  return entries;
}

/** A storage that refuses everything, the way a blocked context does. */
const refuses = (): never => {
  throw new DOMException('access denied', 'SecurityError');
};

describe('browserDeps — the Replay selection store is WIRED (ticket 066, round 3 F1)', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'localStorage');
    vi.restoreAllMocks();
  });

  it('the CONSTRUCTED bag publishes a selectionStore — the R2-1 property probe', () => {
    // The property on the built object, not a string in the file: exactly the
    // assertion the inbound tap needed, for exactly the same reason.
    installStorage();
    const bag = buildReplayDeps();
    expect(bag.selectionStore).toBeDefined();
    expect(typeof bag.selectionStore?.get).toBe('function');
    expect(typeof bag.selectionStore?.set).toBe('function');
  });

  it('what it stores survives a RELOAD — a SECOND bag reads the first bag’s selection', () => {
    // THE assertion of F1. `App`'s in-memory fallback makes the tab round-trip
    // pass with this wiring deleted; reload persistence is the only thing
    // browserDeps contributes, and a fresh bag over the same storage is it.
    const entries = installStorage();

    buildReplayDeps().selectionStore!.set('rec-survives-reload');

    // It really went to BROWSER storage, not to a closure the bag is holding.
    expect(Array.from(entries.values())).toEqual(['rec-survives-reload']);
    expect(buildReplayDeps().selectionStore!.get()).toBe('rec-survives-reload');
  });

  it('the wiring is in buildReplayDeps’ BODY — the R2-1 scoped source scan', () => {
    // Belt to the probe's braces, SCOPED TO THE FUNCTION BODY: an import line
    // or a helper nothing calls cannot satisfy this.
    expect(REPLAY_DEPS_SOURCE).toMatch(/selectionStore: browserSelectionStore\(\)/);
  });

  it('an EMPTY stored value is NO selection, not a selection named ""', () => {
    // A blank key is what a half-written store leaves behind; restored as-is it
    // would be an id naming no row — ticket 066's own contradiction, inverted.
    const entries = installStorage();
    buildReplayDeps().selectionStore!.set('rec-mic');
    const key = Array.from(entries.keys())[0]!;
    entries.set(key, '');

    expect(buildReplayDeps().selectionStore!.get()).toBeNull();
  });

  it('CLEARING the selection REMOVES the key — it does not store the word "null"', () => {
    const entries = installStorage();
    const store = buildReplayDeps().selectionStore!;
    store.set('rec-mic');
    expect(entries.size).toBe(1);

    store.set(null);

    // `setItem(key, String(null))` would leave the key behind and restore the
    // literal id 'null' on the next load. Absence has to be absent.
    expect(entries.size).toBe(0);
    expect(store.get()).toBeNull();
  });

  it('a READ that storage REFUSES is no selection, never a thrown view', () => {
    // Private mode and blocked third-party contexts throw from getItem itself.
    // A lost selection is not worth throwing the whole Replay view away for.
    installStorage({ getItem: refuses });
    const store = buildReplayDeps().selectionStore!;

    expect(() => store.get()).not.toThrow();
    expect(store.get()).toBeNull();
  });

  it('a WRITE that storage REFUSES costs the operator a re-selection, not the click', () => {
    installStorage({ setItem: refuses, removeItem: refuses });
    const store = buildReplayDeps().selectionStore!;

    // Both directions: selecting a clip and clearing the selection. Either one
    // escaping would take out the click handler that called it.
    expect(() => store.set('rec-mic')).not.toThrow();
    expect(() => store.set(null)).not.toThrow();
  });
});
