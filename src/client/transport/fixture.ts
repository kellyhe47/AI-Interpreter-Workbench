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
 * ==========================================================================
 */

import type {
  ConnectionState,
  InterpreterTransport,
  TransportConfig,
  TransportHandlers,
  TransportKind,
  UtteranceCompletion,
} from './types';

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
}

export class FixtureTransport implements InterpreterTransport {
  readonly armId: string;
  readonly kind: TransportKind;
  readonly label: string;
  readonly costPerMinUsd: number;
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
