/**
 * Ticket 012 — Live session controller hook (ONE architecture per session).
 *
 * ============================ API DESIGN (normative) =======================
 * Locked by LiveView.test.tsx / LiveView.flow.test.tsx / App.test.tsx via the
 * DOM contract documented in LiveView.tsx. The hook owns ALL Live behavior;
 * LiveView renders what it returns. Every browser seam is injected through a
 * single `SessionDeps` object so RTL tests never touch real browser APIs.
 *
 * Ownership:
 * - Machine state via useReducer(reduce, ...) from state/sessionMachine.
 *   Initial state = createInitialState(deps.initialState).
 * - Transport lifecycle via TransportRouter (a SWITCH — one active transport).
 *   deps.transportFactory(liveRunConfig) constructs the transport; the
 *   controller builds the TransportConfig, calls start(), and wires the
 *   router handlers. A mode / provider / context-policy change that lands
 *   while the session is live swaps the transport through the router, which
 *   stops the previous one.
 * - THE REALTIME MODEL IS PASSED EXPLICITLY. `liveRunConfig()` resolves
 *   `realtimeModel ?? REALTIME_MODEL` BEFORE the config reaches both the
 *   transport factory and deriveArmTag, because the transport's own default
 *   is the cheap development model `gpt-realtime-mini`, which correctly
 *   derives to 'ad-hoc'. The pill must describe what is configured.
 * - Capture via deps.startCapture({ onChunk, onLevel }): granted →
 *   PERMISSION_GRANTED, denied → PERMISSION_DENIED. onChunk goes to
 *   router.sendAudio. START while micPermission === 'denied' is a machine
 *   no-op, so clicking the denied-card retry does NOT re-invoke
 *   deps.startCapture (browsers do not re-prompt after a denial).
 * - Playback: one ArmPlayback for the session, autoplay ALWAYS on.
 * - Ledger: each onUtteranceComplete assembles/completes an UtteranceRecord,
 *   stamps `runId` with the live session run id (`session-${startedAt}`) and
 *   `arm` with the DERIVED arm tag, and appends it. Footer figures (p50 /
 *   p95 / session $) are read back from ledger.aggregates(sessionRunId) —
 *   never from a hardcoded or illustrative figure.
 * - THE LIVE CAP IS 5 MINUTES (LIVE_MAX_SESSION_MS). On reaching it — or on
 *   Stop — the controller stops capture and the transport, dispatches
 *   FLUSH_DONE with the REAL summary, and appends a LiveSession to the
 *   ledger carrying metrics and NO AUDIO. `quality.wer` is ALWAYS null:
 *   free conversation has no reference transcript.
 * ==========================================================================
 */

import type { ArmTag, ProviderTriple, RunConfig } from '../../core/arms';
import type { Mode } from '../../core/timing';
import type { CaptureResult } from '../audio/capture';
import type { PlaybackAudioContextLike } from '../audio/playback';
import type { RunLedger } from '../state/ledger';
import { createInitialState, type ContextPolicy, type ProviderStage, type SessionState } from '../state/sessionMachine';
import type { InterpreterTransport } from '../transport/types';

/**
 * The resolved recipe for the session's ONE architecture. This is exactly a
 * core/arms RunConfig (so it can be fed straight to deriveArmTag) plus the
 * Live-only, Realtime-only context policy.
 */
export interface LiveRunConfig extends RunConfig {
  architecture: Mode;
  /** ALWAYS set when architecture === 'realtime' (never left to a default). */
  realtimeModel?: string;
  /** Set when architecture === 'cascade'. */
  providers?: ProviderTriple;
  contextPolicy: ContextPolicy;
}

/** Callbacks the controller hands to the injected capture seam. */
export interface CaptureCallbacks {
  /** 480-sample 24 kHz PCM16 frames — forwarded via TransportRouter.sendAudio. */
  onChunk: (frame: Int16Array) => void;
  /** Mic level bars 0..5 for the status-strip meter. */
  onLevel: (bars: number) => void;
}

/**
 * Everything injectable, in one bag. Production builds this from the real
 * browser; tests build it from fakes (see sessionTestKit.ts).
 */
export interface SessionDeps {
  /** Construct (do NOT start) the transport for the session's architecture. */
  transportFactory: (config: LiveRunConfig) => InterpreterTransport;
  /** Narrowed startCapture seam — resolves granted (with handle) or denied. */
  startCapture: (cbs: CaptureCallbacks) => Promise<CaptureResult>;
  /** AudioContext factory for playback. */
  playbackContextFactory: () => PlaybackAudioContextLike;
  /** Shared run ledger (also handed to ResultsView by App). */
  ledger: RunLedger;
  /** Injectable wall clock (epoch ms). */
  now: () => number;
  /** Test seed forwarded into createInitialState. */
  initialState?: Partial<SessionState>;
}

/** The single target card's view of the current (latest) utterance. */
export interface TargetView {
  utt: number;
  status: 'in-flight' | 'ready' | 'failed';
  /** True once the session has received any utterance event. */
  hasData: boolean;
  targetText: string;
  failMessage: string | null;
  /** Raw timing marks by event name (epoch ms). */
  timings: Record<string, number>;
  /** Total enqueued TTS audio for this utterance, ms. */
  durationMs: number;
}

export interface SessionFooterData {
  utterances: number;
  p50Ms: number | null;
  p95Ms: number | null;
  costUsd: number;
}

export interface SessionActions {
  start: () => void;
  stop: () => void;
  newSession: () => void;
  requestMode: (mode: Mode) => void;
  cycleLanguage: () => void;
  swapDirection: () => void;
  /** Advance one cascade stage to the next model in MENUS[stage]. */
  cycleProvider: (stage: ProviderStage) => void;
  setContextPolicy: (value: ContextPolicy) => void;
  togglePlay: () => void;
  reconnect: () => void;
}

export interface SessionController {
  state: SessionState;
  sourceText: string;
  level: number;
  /** DERIVED via deriveArmTag(runConfig) — never set by any control. */
  armTag: ArmTag;
  /** The resolved recipe handed to the transport factory. */
  runConfig: LiveRunConfig;
  target: TargetView;
  footer: SessionFooterData;
  elapsedMs: number;
  actions: SessionActions;
}

const noop = (): void => {};

/** STUB (ticket 012 red phase) — no behavior, just the shape. */
export function useSessionController(deps: SessionDeps): SessionController {
  const state = createInitialState(deps.initialState);
  return {
    state,
    sourceText: '',
    level: 0,
    armTag: 'ad-hoc',
    runConfig: { architecture: state.mode, contextPolicy: state.contextPolicy },
    target: {
      utt: -1,
      status: 'ready',
      hasData: false,
      targetText: '',
      failMessage: null,
      timings: {},
      durationMs: 0,
    },
    footer: { utterances: 0, p50Ms: null, p95Ms: null, costUsd: 0 },
    elapsedMs: 0,
    actions: {
      start: noop,
      stop: noop,
      newSession: noop,
      requestMode: noop,
      cycleLanguage: noop,
      swapDirection: noop,
      cycleProvider: noop,
      setContextPolicy: noop,
      togglePlay: noop,
      reconnect: noop,
    },
  };
}
