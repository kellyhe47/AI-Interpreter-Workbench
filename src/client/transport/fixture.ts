/**
 * Ticket 011 — Fixture transport: scripted event playlist on timers.
 * Used by UI tests (ticket 012) and dev mode. Exposes the SAME handler
 * surface as the real transports.
 *
 * ============================ API DESIGN (normative) =======================
 * Locked by fixture.test.ts:
 *
 * new FixtureTransport(opts)
 *   opts: {
 *     armId, kind? ('cascade' default), label?, costPerMinUsd?,
 *     script: FixtureScriptEvent[],
 *     failStart?: boolean   — fault injection: start() emits
 *       onError({ message: 'fixture: start failed', opaque: true }) +
 *       onConnectionState('disconnected') and still RESOLVES (same
 *       no-unhandled-rejection contract as the real transports).
 *   }
 *
 * start(): emits onConnectionState('connected'), then schedules every script
 * event with setTimeout(at ms from start). Events fire in `at` order and map
 * 1:1 onto the handler surface (see FixtureScriptEvent variants). Timing
 * events default t to Date.now() when the script omits it. Error script
 * events pass message/opaque/stage through verbatim — fault injection is
 * just an error (or connection) event in the script.
 *
 * sendAudio(pcm): records chunks in the public `received: Int16Array[]`
 * array so tests can assert fan-out.
 *
 * stop(): cancels all pending timers — NO events after stop().
 *
 * Ticket 008 — the fixture ALSO serves Replay (fed from a Recording), not just
 * Live. `replayFixtureScript({ recording, kind })` derives a well-formed
 * utterance timeline from a Recording's duration/speechEndMs — source partials
 * -> final, target deltas -> final, canonical timing marks for the kind, and
 * output audio — every event landing AFTER the clip's speech end, the way a
 * real pipeline would answer. `providers` is fixture-named
 * (FIXTURE_PROVIDERS), so anything it produces is excluded by the ledger's
 * realness rule and can never become reported evidence.
 * ==========================================================================
 */

import type { ProviderTriple } from '../../core/arms';
import { SAMPLE_RATE } from '../../core/protocol';
import type {
  ConnectionState,
  InterpreterTransport,
  TransportConfig,
  TransportHandlers,
  TransportKind,
  UtteranceCompletion,
} from './types';

/**
 * The provider triple every fixture transport advertises. `'fixture'` is the
 * exact token the ledger's realness rule (isRealRun / isRealRecord) rejects.
 */
export const FIXTURE_PROVIDERS: ProviderTriple = { stt: 'fixture', mt: 'fixture', tts: 'fixture' };

/** The Recording fields the replay fixture needs. */
export interface ReplayRecordingLike {
  id: string;
  durationMs: number;
  /** Ground-truth speech end offset; the fixture answers only after it. */
  speechEndMs: number;
}

export interface ReplayFixtureOptions {
  recording: ReplayRecordingLike;
  /** Which timing vocabulary to emit. Default 'cascade'. */
  kind?: TransportKind;
  sourceText?: string;
  targetText?: string;
}

export type FixtureScriptEvent =
  | { at: number; type: 'sourceText'; kind: 'partial' | 'final'; text: string; utt: number }
  | { at: number; type: 'targetText'; kind: 'delta' | 'final'; text: string; utt: number }
  | { at: number; type: 'audio'; pcm: Int16Array; utt: number }
  | { at: number; type: 'timing'; event: string; utt: number; t?: number; stage?: string }
  | { at: number; type: 'utteranceComplete'; record: UtteranceCompletion }
  | { at: number; type: 'error'; message: string; opaque: boolean; stage?: string }
  | { at: number; type: 'connection'; state: ConnectionState; attempt?: number };

export interface FixtureTransportOptions {
  armId: string;
  kind?: TransportKind;
  label?: string;
  costPerMinUsd?: number;
  script: FixtureScriptEvent[];
  failStart?: boolean;
  /** Advertised triple; defaults to FIXTURE_PROVIDERS. */
  providers?: ProviderTriple;
}

export class FixtureTransport implements InterpreterTransport {
  readonly armId: string;
  readonly kind: TransportKind;
  readonly label: string;
  readonly costPerMinUsd: number;
  /** Fixture-named by default — never real evidence. */
  readonly providers: ProviderTriple;
  /** Chunks passed to sendAudio, in order (for fan-out assertions). */
  readonly received: Int16Array[] = [];

  private readonly script: FixtureScriptEvent[];
  private readonly failStart: boolean;
  private handlers: TransportHandlers = {};
  private timers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;

  constructor(opts: FixtureTransportOptions) {
    this.armId = opts.armId;
    this.kind = opts.kind ?? 'cascade';
    this.label = opts.label ?? 'Fixture';
    this.costPerMinUsd = opts.costPerMinUsd ?? 0;
    this.script = opts.script;
    this.failStart = opts.failStart ?? false;
    this.providers = opts.providers ?? FIXTURE_PROVIDERS;
  }

  async start(_config: TransportConfig): Promise<void> {
    if (this.failStart) {
      this.handlers.onError?.({ message: 'fixture: start failed', opaque: true });
      this.handlers.onConnectionState?.('disconnected');
      return;
    }
    this.handlers.onConnectionState?.('connected');
    const events = [...this.script].sort((a, b) => a.at - b.at);
    for (const ev of events) {
      this.timers.push(
        setTimeout(() => {
          if (!this.stopped) this.fire(ev);
        }, ev.at),
      );
    }
  }

  private fire(ev: FixtureScriptEvent): void {
    const h = this.handlers;
    switch (ev.type) {
      case 'sourceText':
        h.onSourceText?.({ kind: ev.kind, text: ev.text, utt: ev.utt });
        break;
      case 'targetText':
        h.onTargetText?.({ kind: ev.kind, text: ev.text, utt: ev.utt });
        break;
      case 'audio':
        h.onAudio?.(ev.pcm, ev.utt);
        break;
      case 'timing':
        h.onTiming?.({ event: ev.event, t: ev.t ?? Date.now(), utt: ev.utt, stage: ev.stage });
        break;
      case 'utteranceComplete':
        h.onUtteranceComplete?.(ev.record);
        break;
      case 'error':
        h.onError?.({ message: ev.message, opaque: ev.opaque, stage: ev.stage });
        break;
      case 'connection':
        h.onConnectionState?.(ev.state, ev.attempt);
        break;
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  sendAudio(pcm: Int16Array): void {
    this.received.push(pcm);
  }

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }
}

/* ---------------------------------------------------------------------------
 * Ticket 008 — Replay: a script derived from a Recording.
 *
 * THE TIMELINE IS ANCHORED ON THE RECORDING, not on constants. Every event
 * lands at `speechEndMs + k * u`, where u is a slice of the clip's silence
 * tail. Two consequences the tests pin:
 *   - nothing answers before the clip's speech has ended, which is the only
 *     ordering a real pipeline can produce; and
 *   - a different Recording moves the whole timeline with it, so a fixture
 *     replay of a short clip finishes early and one of a long clip does not.
 * `t` is deliberately omitted from the timing marks: FixtureTransport stamps
 * Date.now() at fire time, so the marks carry real (virtual) clock values in
 * fire order rather than a second, hand-written schedule that could disagree
 * with `at`.
 * ------------------------------------------------------------------------ */

const REPLAY_SOURCE_TEXT = 'hello there';
const REPLAY_TARGET_TEXT = 'hola qué tal';

/** A recognisable non-silent chunk — content is irrelevant, presence is not. */
function fixturePcm(samples: number): Int16Array {
  return Int16Array.from({ length: samples }, (_, i) =>
    Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)),
  );
}

/** The utterance timeline a Recording would produce. Every `at` >= speechEndMs. */
export function replayFixtureScript(opts: ReplayFixtureOptions): FixtureScriptEvent[] {
  const { recording } = opts;
  const kind = opts.kind ?? 'cascade';
  const sourceText = opts.sourceText ?? REPLAY_SOURCE_TEXT;
  const targetText = opts.targetText ?? REPLAY_TARGET_TEXT;

  const base = recording.speechEndMs;
  const tail = Math.max(recording.durationMs - recording.speechEndMs, 0);
  /** One step of the answer timeline, derived from the clip's silence tail. */
  const u = Math.max(1, Math.round(tail / 8));
  const at = (k: number): number => base + k * u;

  const sourcePartial = sourceText.split(' ')[0] ?? sourceText;
  const targetDelta = targetText.split(' ')[0] ?? targetText;
  const chunk = (): Int16Array => fixturePcm(Math.max(1, Math.round((SAMPLE_RATE * u) / 1000)));

  const marks: FixtureScriptEvent[] =
    kind === 'realtime'
      ? [
          { at: at(0), type: 'timing', event: 'speech_end', utt: 0 },
          { at: at(1), type: 'timing', event: 'server_speech_stopped', utt: 0 },
          { at: at(5), type: 'timing', event: 'first_audio_delta', utt: 0 },
        ]
      : [
          { at: at(0), type: 'timing', event: 'speech_end', utt: 0 },
          { at: at(1), type: 'timing', event: 'vad_fired', utt: 0, stage: 'stt' },
          { at: at(3), type: 'timing', event: 'stt_final', utt: 0, stage: 'stt' },
          { at: at(4), type: 'timing', event: 'mt_first_token', utt: 0, stage: 'mt' },
          { at: at(5), type: 'timing', event: 'tts_first_byte', utt: 0, stage: 'tts' },
        ];

  const script: FixtureScriptEvent[] = [
    ...marks,
    { at: at(2), type: 'sourceText', kind: 'partial', text: sourcePartial, utt: 0 },
    { at: at(3), type: 'sourceText', kind: 'final', text: sourceText, utt: 0 },
    { at: at(4), type: 'targetText', kind: 'delta', text: targetDelta, utt: 0 },
    { at: at(5), type: 'audio', pcm: chunk(), utt: 0 },
    { at: at(6), type: 'targetText', kind: 'final', text: targetText, utt: 0 },
    { at: at(6), type: 'audio', pcm: chunk(), utt: 0 },
    { at: at(7), type: 'utteranceComplete', record: { utt: 0 } },
  ];

  // Sorted here as well as in start(): callers read the script directly.
  return script.sort((a, b) => a.at - b.at);
}

/** A FixtureTransport pre-loaded with `replayFixtureScript(opts)`. */
export function createReplayFixtureTransport(
  opts: ReplayFixtureOptions & { armId?: string; providers?: ProviderTriple },
): FixtureTransport {
  return new FixtureTransport({
    armId: opts.armId ?? `fixture-replay:${opts.recording.id}`,
    kind: opts.kind ?? 'cascade',
    label: 'Fixture (replay)',
    script: replayFixtureScript(opts),
    providers: opts.providers,
  });
}
