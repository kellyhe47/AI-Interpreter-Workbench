/**
 * Ticket 012 — Session view controller hook (STUB — tests written first).
 *
 * ============================ API DESIGN (normative) =======================
 * Locked by SessionView.test.tsx / SessionView.flow.test.tsx / App.test.tsx
 * via the DOM contract documented in SessionView.tsx. The hook owns ALL
 * session-view behavior; SessionView renders what it returns. Every browser
 * seam is injected through a single `SessionDeps` object so RTL tests never
 * touch real browser APIs (they inject FixtureTransport factories, fake
 * capture, a fake playback AudioContext, and a fake clock).
 *
 * Ownership:
 * - Machine state via useReducer(reduce, ...) from state/sessionMachine.
 *   Initial state = createInitialState({ ...deps.initialState, arms }) where
 *   `arms` defaults to [armForMode(initial mode)] when deps.initialState
 *   does not name arms — machine arm ids ARE arm-catalog ids ('realtime' |
 *   'cascade-openai' | 'cascade-best'), never the abstract 'arm-1'.
 * - Transport lifecycle via ArmRouter. deps.transportFactory(def) constructs
 *   the transport for an arm (tests return FixtureTransport); the controller
 *   builds the TransportConfig, calls start(), and wires router handlers.
 * - Capture via deps.startCapture({ onChunk, onLevel }): resolves
 *   { status: 'granted', handle } → dispatch PERMISSION_GRANTED; resolves
 *   { status: 'denied', ... } → dispatch PERMISSION_DENIED. onChunk fans out
 *   through router.sendAudio. While the promise is outstanding the machine
 *   sits in 'requesting-permission' (mic indicator 'mic prompt open…').
 *   START while micPermission === 'denied' is a machine no-op, so clicking
 *   the denied-card retry does NOT re-invoke deps.startCapture.
 * - Playback: one ArmPlayback per active arm, constructed with
 *   deps.playbackContextFactory and autoplay = machine autoplay (single arm
 *   only). onAudio(armId, pcm) → that arm's playback.enqueue.
 * - Ledger: on each arm's onUtteranceComplete the controller assembles /
 *   completes an UtteranceRecord (cascade: server record; realtime: client
 *   assembly from accumulated transcripts + timing marks), STAMPS
 *   record.runId with the live session run id (`session-${startedAt}` —
 *   one shared run id per session, prefix 'session' is contract) and
 *   ledger.append()s it. Session footer figures (p50 / p95 / session $) are
 *   read back from ledger.aggregates(sessionRunId) — never from any
 *   hardcoded or illustrative figure.
 *
 * Event mapping (transport → machine):
 * - onSourceText 'partial' (FIRST partial of an utterance) → SPEECH_DETECTED.
 *   Partials carry ACCUMULATED text (transport contract) and replace the
 *   source card text; 'final' replaces it with the final transcript.
 * - onTargetText 'delta' → append to the arm's target text; 'final' →
 *   replace with the full translation.
 * - onTiming → accumulate per (arm, utt) timestamps; stage rows derive via
 *   deriveCascadeIntervals / deriveRealtimeIntervals (core/timing).
 * - onUtteranceComplete → arm marked complete; when ALL active arms have
 *   completed (or failed — a failed arm counts as settled so one dead arm
 *   never wedges the session) the current utterance: dispatch ARMS_SETTLED
 *   then UTTERANCE_BOUNDARY (applies any pending switch, bumps
 *   utteranceCount).
 * - onError → mark that arm failed for the current utterance (per-arm fail
 *   copy is the VIEW's concern; see SessionView.tsx). Session keeps running.
 * - onConnectionState 'reconnecting' → CONNECTION_LOST (no-op when already
 *   reconnecting) + RECONNECT_ATTEMPT per event; 'connected' while
 *   reconnecting → RECONNECTED; 'disconnected' → RECONNECT_EXHAUSTED.
 * - Stop button → STOP {now: deps.now()} → stop capture + router.stopAll()
 *   → FLUSH_DONE with the REAL summary: elapsedMs = stoppedAt − startedAt,
 *   utterances = utteranceCount, dropped = utterances with ≥1 failed arm,
 *   costUsd = ledger session aggregate cost.
 *
 * Arm catalog / add-arm rule (mirrors the design mock):
 * - ARM_CATALOG below is the fixed menu. Single-arm display follows the
 *   current mode (mode realtime → arm 'realtime', cascade → 'cascade-openai').
 * - Next addable arm = first of ['cascade-openai', 'realtime',
 *   'cascade-best'] not already active; add pill label
 *   `+ ${label} · $${costPerMinUsd.toFixed(3)}/min`. Max 3 arms → no pill.
 *
 * DELIBERATE DEVIATION from the mock (documented for the implementer):
 * the Cantonese-on-Realtime warning banners render from warnings(langIdx,
 * reversed, activeArmModes) whenever the session is NOT stopped — INCLUDING
 * idle (you are configuring before you start; hiding the warning until
 * after start helps nobody). The mock gated them on `active`; the PRD only
 * requires "warn, never block".
 * ==========================================================================
 */

import type { Mode } from '../../core/timing';
import type { CaptureResult } from '../audio/capture';
import type { PlaybackAudioContextLike } from '../audio/playback';
import type { RunLedger } from '../state/ledger';
import type { SessionState } from '../state/sessionMachine';
import type { InterpreterTransport } from '../transport/types';

/** One entry in the fixed arm menu. */
export interface ArmDef {
  /** Machine arm id AND transport armId. */
  id: string;
  mode: Mode;
  /** Display label, e.g. 'Cascade · OpenAI'. */
  label: string;
  costPerMinUsd: number;
}

/** Fixed arm menu (order matters for the next-addable-arm rule). */
export const ARM_CATALOG: readonly ArmDef[] = [
  { id: 'realtime', mode: 'realtime', label: 'Realtime', costPerMinUsd: 0.14 },
  { id: 'cascade-openai', mode: 'cascade', label: 'Cascade · OpenAI', costPerMinUsd: 0.021 },
  { id: 'cascade-best', mode: 'cascade', label: 'Cascade · best-of-breed', costPerMinUsd: 0.055 },
];

/** Callbacks the controller hands to the injected capture seam. */
export interface CaptureCallbacks {
  /** 480-sample 24 kHz PCM16 frames — fanned out via ArmRouter.sendAudio. */
  onChunk: (frame: Int16Array) => void;
  /** Mic level bars 0..5 for the status-strip meter. */
  onLevel: (bars: number) => void;
}

/**
 * Everything injectable, in one bag. Production builds this from the real
 * browser (startCapture with getUserMedia + worklet pipeline, real
 * AudioContexts, RealtimeTransport/CascadeTransport factories, Date.now);
 * tests build it from fakes (see sessionTestKit.ts).
 */
export interface SessionDeps {
  /** Construct (do NOT start) the transport for an arm. */
  transportFactory: (def: ArmDef) => InterpreterTransport;
  /** Narrowed startCapture seam — resolves granted (with handle) or denied. */
  startCapture: (cbs: CaptureCallbacks) => Promise<CaptureResult>;
  /** AudioContext factory for per-arm ArmPlayback. */
  playbackContextFactory: () => PlaybackAudioContextLike;
  /** Shared run ledger (also handed to ResultsView by App). */
  ledger: RunLedger;
  /** Injectable wall clock (epoch ms). */
  now: () => number;
  /** Test seed forwarded into createInitialState. */
  initialState?: Partial<SessionState>;
}

/**
 * Controller return surface. `state` is the raw machine state; the rest of
 * the view-model / action shape is the implementer's to design — the locked
 * contract is the rendered DOM (see SessionView.tsx).
 */
export interface SessionController {
  state: SessionState;
  [key: string]: unknown;
}

export function useSessionController(_deps: SessionDeps): SessionController {
  throw new Error('useSessionController not implemented (ticket 012)');
}
