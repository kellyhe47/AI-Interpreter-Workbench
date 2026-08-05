/**
 * Ticket 012 — Session view controller hook.
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

import { useEffect, useReducer, useRef } from 'react';
import type { Mode, UtteranceRecord } from '../../core/timing';
import type { CaptureHandle, CaptureResult } from '../audio/capture';
import { ArmPlayback, type ArmPlaybackOptions } from '../audio/playback';
import type { PlaybackAudioContextLike } from '../audio/playback';
import type { RunLedger } from '../state/ledger';
import {
  createInitialState,
  pairs,
  reduce,
  type SessionState,
  type SessionStatus,
} from '../state/sessionMachine';
import { ArmRouter } from '../transport/router';
import type { InterpreterTransport, TransportConfig, UtteranceCompletion } from '../transport/types';

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
  /**
   * Ticket 014 — injectable RNG for the blind-compare draw (default
   * Math.random). CONTRACT (locked by BlindCompare.test.tsx): each open of
   * the blind-compare card draws a fresh presentation order from the ACTIVE
   * arm order via Fisher–Yates, consuming exactly N−1 rng() values for N
   * arms — so with two arms exactly ONE value per open, where rng() < 0.5
   * keeps the active order and rng() >= 0.5 swaps the pair.
   */
  rng?: () => number;
}

/** Per-arm view of the current (latest) utterance. */
export interface ArmUtteranceView {
  utt: number;
  status: 'in-flight' | 'ready' | 'failed';
  /** True once this arm has received any utterance event this session. */
  hasData: boolean;
  targetText: string;
  targetPartials: string[];
  sourcePartials: string[];
  sourceFinal: string;
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

export type BlindSampleKey = 'A' | 'B';

/** Ticket 014 — blind-compare slice (rendered by components/session/BlindCompare). */
export interface BlindSlice {
  open: boolean;
  revealed: boolean;
  /** Presented arm order for the open draw; order[0] is Sample A. */
  order: string[];
  scores: Record<BlindSampleKey, number | null>;
  /** True when the last settled utterance had at least one failed arm. */
  lastUtteranceFailed: boolean;
}

export interface SessionActions {
  start: () => void;
  stop: () => void;
  newSession: () => void;
  requestMode: (mode: Mode) => void;
  cycleLanguage: () => void;
  swapDirection: () => void;
  setAutoplay: (value: boolean) => void;
  addArm: () => void;
  removeArm: (armId: string) => void;
  togglePlay: (armId: string) => void;
  reconnect: () => void;
  /** Ticket 014 — blind compare. */
  toggleBlind: () => void;
  scoreBlind: (sample: BlindSampleKey, score: number) => void;
  submitBlind: () => void;
  playBlindSample: (sample: BlindSampleKey) => void;
}

/**
 * Controller return surface. `state` is the raw machine state; the rest of
 * the view-model / action shape is the implementer's to design — the locked
 * contract is the rendered DOM (see SessionView.tsx).
 */
export interface SessionController {
  state: SessionState;
  sourceText: string;
  level: number;
  activeArms: ArmDef[];
  nextArm: ArmDef | null;
  armViews: Record<string, ArmUtteranceView>;
  footer: SessionFooterData;
  elapsedMs: number;
  blind: BlindSlice;
  actions: SessionActions;
  [key: string]: unknown;
}

/** Exact opaque-failure copy (matches REALTIME_OPAQUE_ERROR_MESSAGE). */
const OPAQUE_FAILURE_COPY = 'opaque failure — no stage attribution · session still running';

const LANG_CODE: Record<string, string> = { English: 'EN', Spanish: 'ES', Cantonese: 'YUE' };
const LANG_LOWER: Record<string, string> = { English: 'en', Spanish: 'es', Cantonese: 'yue' };

/** Cascade provider selections per arm (server registry names). */
const CASCADE_PROVIDERS: Record<string, { stt: string; mt: string; tts: string }> = {
  'cascade-openai': { stt: 'openai', mt: 'openai', tts: 'openai' },
  'cascade-best': { stt: 'openai', mt: 'openai', tts: 'elevenlabs' },
};

/** Next-addable-arm precedence (see doc comment). */
const ADD_ORDER: readonly string[] = ['cascade-openai', 'realtime', 'cascade-best'];

const TRANSPORT_STATUSES: readonly SessionStatus[] = [
  'listening',
  'processing',
  'ready',
  'playing',
  'reconnecting',
  'disconnected',
];

const STOPPABLE_STATUSES: readonly SessionStatus[] = [
  'requesting-permission',
  'listening',
  'processing',
  'ready',
  'playing',
  'reconnecting',
  'disconnected',
];

const TICKING_STATUSES: readonly SessionStatus[] = [
  'listening',
  'processing',
  'ready',
  'playing',
  'reconnecting',
  'disconnected',
];

const catalogById = new Map(ARM_CATALOG.map((d) => [d.id, d]));

export function armForMode(mode: Mode): string {
  return mode === 'realtime' ? 'realtime' : 'cascade-openai';
}

function emptyView(): ArmUtteranceView {
  return {
    utt: -1,
    status: 'ready',
    hasData: false,
    targetText: '',
    targetPartials: [],
    sourcePartials: [],
    sourceFinal: '',
    failMessage: null,
    timings: {},
    durationMs: 0,
  };
}

function initialStateFromDeps(deps: SessionDeps): SessionState {
  const overrides = deps.initialState ?? {};
  const mode = overrides.mode ?? 'cascade';
  const arms = overrides.arms ?? [armForMode(mode)];
  return createInitialState({ ...overrides, arms });
}

interface ArmRuntime {
  def: ArmDef;
  /** Mutable options bag shared with the ArmPlayback (autoplay re-read on reset). */
  playbackOpts: ArmPlaybackOptions;
  playback: ArmPlayback;
  view: ArmUtteranceView;
}

interface BlindStore {
  open: boolean;
  drawId: string | null;
  order: string[];
  scores: Record<BlindSampleKey, number | null>;
  revealed: boolean;
}

interface ControllerStore {
  router: ArmRouter;
  captureHandle: CaptureHandle | null;
  runId: string | null;
  arms: Map<string, ArmRuntime>;
  sourceText: string;
  utteranceOpen: boolean;
  settled: Set<string>;
  failedThisUtterance: boolean;
  lastUtteranceFailed: boolean;
  dropped: number;
  level: number;
  blind: BlindStore;
  drawCounter: number;
}

function emptyBlind(): BlindStore {
  return { open: false, drawId: null, order: [], scores: { A: null, B: null }, revealed: false };
}

export function useSessionController(deps: SessionDeps): SessionController {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const [state, dispatch] = useReducer(reduce, deps, initialStateFromDeps);
  const stateRef = useRef(state);
  stateRef.current = state;

  const [, bump] = useReducer((c: number) => c + 1, 0);

  const storeRef = useRef<ControllerStore | null>(null);
  if (storeRef.current === null) {
    const store: ControllerStore = {
      router: new ArmRouter(),
      captureHandle: null,
      runId: null,
      arms: new Map(),
      sourceText: '',
      utteranceOpen: false,
      settled: new Set(),
      failedThisUtterance: false,
      lastUtteranceFailed: false,
      dropped: 0,
      level: 0,
      blind: emptyBlind(),
      drawCounter: 0,
    };
    storeRef.current = store;

    /** Reset the arm's per-utterance view when a NEW utterance number appears. */
    const touch = (rt: ArmRuntime, utt: number | undefined): void => {
      if (utt === undefined || utt <= rt.view.utt) {
        if (!rt.view.hasData) {
          rt.view.hasData = true;
          rt.view.status = 'in-flight';
          if (utt !== undefined) rt.view.utt = utt;
        }
        return;
      }
      rt.view = { ...emptyView(), utt, hasData: true, status: 'in-flight' };
      rt.playback.reset();
    };

    /** Assemble/complete the UtteranceRecord for the ledger, stamped with the
     * live-session run id. Cascade delivers the server's record; realtime is
     * assembled client-side from accumulated transcripts + timing marks. */
    const assembleRecord = (rt: ArmRuntime, completion: UtteranceCompletion): UtteranceRecord => {
      const runId = store.runId ?? 'session-unknown';
      if (
        completion.id !== undefined &&
        completion.timings !== undefined &&
        completion.providers !== undefined
      ) {
        return { ...(completion as UtteranceRecord), runId };
      }
      const s = stateRef.current;
      const pair = pairs[s.langIdx] ?? pairs[0]!;
      const src = s.reversed ? pair.tgt : pair.src;
      const tgt = s.reversed ? pair.src : pair.tgt;
      const view = rt.view;
      return {
        id: `utt-${completion.utt ?? view.utt}`,
        arm: rt.def.id,
        mode: rt.def.mode,
        languagePair: `${LANG_CODE[pair.src] ?? pair.src}↔${LANG_CODE[pair.tgt] ?? pair.tgt}`,
        direction: `${LANG_LOWER[src] ?? src}→${LANG_LOWER[tgt] ?? tgt}`,
        sourcePartials: [...view.sourcePartials],
        sourceFinal: view.sourceFinal,
        targetPartials: [...view.targetPartials],
        targetFinal: view.targetText,
        audioState: 'queued',
        audioDurationMs: view.durationMs,
        timings: { ...view.timings } as UtteranceRecord['timings'],
        speechEndSource: 'vad',
        providers: { stt: 'openai-realtime', mt: 'openai-realtime', tts: 'openai-realtime' },
        costUnits: 0,
        corpusId: 'live-mic',
        runId,
      };
    };

    /** A settled arm has either completed or failed the current utterance;
     * when every active arm has settled: ARMS_SETTLED then UTTERANCE_BOUNDARY. */
    const settle = (armId: string, failed: boolean): void => {
      if (!store.utteranceOpen) return;
      store.settled.add(armId);
      if (failed) store.failedThisUtterance = true;
      const active = stateRef.current.arms;
      if (active.length > 0 && active.every((id) => store.settled.has(id))) {
        store.utteranceOpen = false;
        store.settled.clear();
        store.lastUtteranceFailed = store.failedThisUtterance;
        if (store.failedThisUtterance) store.dropped += 1;
        store.failedThisUtterance = false;
        dispatch({ type: 'ARMS_SETTLED' });
        dispatch({ type: 'UTTERANCE_BOUNDARY' });
      }
    };

    store.router.setHandlers({
      onSourceText: (e) => {
        const rt = store.arms.get(e.armId);
        if (rt) touch(rt, e.utt);
        if (e.kind === 'partial') {
          if (rt) rt.view.sourcePartials.push(e.text);
          if (!store.utteranceOpen) {
            store.utteranceOpen = true;
            store.settled.clear();
            store.failedThisUtterance = false;
            dispatch({ type: 'SPEECH_DETECTED' });
          }
        } else if (rt) {
          rt.view.sourceFinal = e.text;
        }
        store.sourceText = e.text;
        bump();
      },
      onTargetText: (e) => {
        const rt = store.arms.get(e.armId);
        if (!rt) return;
        touch(rt, e.utt);
        if (e.kind === 'delta') {
          rt.view.targetPartials.push(e.text);
          rt.view.targetText += e.text;
        } else {
          rt.view.targetText = e.text;
        }
        bump();
      },
      onTiming: (e) => {
        const rt = store.arms.get(e.armId);
        if (!rt) return;
        touch(rt, e.utt);
        rt.view.timings[e.event] = e.t;
        bump();
      },
      onAudio: (e) => {
        const rt = store.arms.get(e.armId);
        if (!rt) return;
        touch(rt, e.utt);
        rt.playback.enqueue(e.pcm);
        rt.view.durationMs = rt.playback.durationMs;
        bump();
      },
      onUtteranceComplete: (e) => {
        const rt = store.arms.get(e.armId);
        if (!rt) return;
        touch(rt, e.record.utt);
        depsRef.current.ledger.append(assembleRecord(rt, e.record));
        const failed = rt.view.status === 'failed';
        if (!failed) rt.view.status = 'ready';
        bump();
        settle(e.armId, failed);
      },
      onError: (e) => {
        const rt = store.arms.get(e.armId);
        if (rt) {
          rt.view.hasData = true;
          rt.view.status = 'failed';
          rt.view.failMessage = e.opaque
            ? OPAQUE_FAILURE_COPY
            : `${e.message} — session still running`;
        }
        bump();
        settle(e.armId, true);
      },
      onConnectionState: (e) => {
        if (e.state === 'reconnecting') {
          dispatch({ type: 'CONNECTION_LOST' });
          dispatch({ type: 'RECONNECT_ATTEMPT' });
        } else if (e.state === 'connected') {
          dispatch({ type: 'RECONNECTED' });
        } else {
          dispatch({ type: 'RECONNECT_EXHAUSTED' });
        }
      },
    });
  }
  const store = storeRef.current;

  const buildConfig = (def: ArmDef): TransportConfig => {
    const s = stateRef.current;
    const pair = pairs[s.langIdx] ?? pairs[0]!;
    const src = s.reversed ? pair.tgt : pair.src;
    const tgt = s.reversed ? pair.src : pair.tgt;
    return {
      languagePair: `${LANG_CODE[pair.src] ?? pair.src}↔${LANG_CODE[pair.tgt] ?? pair.tgt}`,
      direction: `${LANG_LOWER[src] ?? src}→${LANG_LOWER[tgt] ?? tgt}`,
      targetLanguage: tgt,
      providers: def.mode === 'cascade' ? CASCADE_PROVIDERS[def.id] : undefined,
    };
  };

  const createRuntime = (def: ArmDef): ArmRuntime => {
    const playbackOpts: ArmPlaybackOptions = {
      audioContextFactory: depsRef.current.playbackContextFactory,
      autoplay: stateRef.current.arms.length === 1 && stateRef.current.autoplay,
    };
    return {
      def,
      playbackOpts,
      playback: new ArmPlayback(playbackOpts),
      view: emptyView(),
    };
  };

  const requestCapture = async (): Promise<void> => {
    const result: CaptureResult = await depsRef.current.startCapture({
      onChunk: (frame) => store.router.sendAudio(frame),
      onLevel: (bars) => {
        store.level = bars;
        bump();
      },
    });
    if (result.status === 'granted') {
      store.captureHandle = result.handle;
      dispatch({ type: 'PERMISSION_GRANTED', now: depsRef.current.now() });
    } else {
      dispatch({ type: 'PERMISSION_DENIED' });
    }
  };

  // Transport lifecycle reconciliation: while the session is live, the router
  // holds exactly one started transport per machine arm.
  useEffect(() => {
    if (!TRANSPORT_STATUSES.includes(state.status)) return;
    const router = store.router;
    for (const id of router.armIds) {
      if (!state.arms.includes(id)) {
        router.removeArm(id);
        store.arms.delete(id);
      }
    }
    for (const id of state.arms) {
      if (router.getArm(id)) continue;
      const def = catalogById.get(id);
      if (!def) continue;
      if (!store.arms.has(id)) store.arms.set(id, createRuntime(def));
      const transport = depsRef.current.transportFactory(def);
      router.addArm(transport);
      void transport.start(buildConfig(def));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.arms]);

  // Keep each arm's playback autoplay in sync (single arm only, per PRD).
  useEffect(() => {
    const autoplay = state.arms.length === 1 && state.autoplay;
    for (const rt of store.arms.values()) rt.playbackOpts.autoplay = autoplay;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.arms, state.autoplay]);

  // Single-arm display follows the applied mode (mock rule): when the mode
  // patch lands (instantly while idle, at the boundary while active), swap
  // the lone arm to the mode's catalog arm.
  useEffect(() => {
    if (state.arms.length !== 1) return;
    const only = state.arms[0]!;
    const def = catalogById.get(only);
    if (def && def.mode !== state.mode) {
      dispatch({ type: 'REMOVE_ARM', armId: only });
      dispatch({ type: 'ADD_ARM', armId: armForMode(state.mode) });
    }
  }, [state.mode, state.arms]);

  // Elapsed ticker — re-render once a second while the session runs.
  useEffect(() => {
    if (!TICKING_STATUSES.includes(state.status)) return;
    const timer = setInterval(() => bump(), 1000);
    return () => clearInterval(timer);
  }, [state.status]);

  const togglePlayArm = (armId: string): void => {
    const s = stateRef.current;
    const rt = store.arms.get(armId);
    if (!rt) return;
    if (s.playingArm === armId) {
      rt.playback.pause();
      dispatch({ type: 'PLAYBACK_ENDED' });
    } else {
      rt.playback.onEnded(() => dispatch({ type: 'PLAYBACK_ENDED' }));
      rt.playback.play();
      dispatch({ type: 'PLAY', armId });
    }
  };

  const actions: SessionActions = {
    start: () => {
      const s = stateRef.current;
      const fresh = s.status === 'idle' && s.micPermission !== 'denied';
      const now = depsRef.current.now();
      dispatch({ type: 'START', now });
      if (fresh) {
        store.runId = `session-${now}`;
        store.dropped = 0;
        void requestCapture();
      }
    },
    stop: () => {
      const s = stateRef.current;
      if (!STOPPABLE_STATUSES.includes(s.status)) return;
      const now = depsRef.current.now();
      dispatch({ type: 'STOP', now });
      store.captureHandle?.stop();
      store.captureHandle = null;
      store.router.stopAll();
      const agg = depsRef.current.ledger.aggregates(store.runId ?? '');
      const costUsd = Object.values(agg.perArm).reduce((sum, a) => sum + a.costUsd, 0);
      dispatch({
        type: 'FLUSH_DONE',
        summary: {
          elapsedMs: now - (s.startedAt ?? now),
          utterances: s.utteranceCount,
          dropped: store.dropped,
          costUsd,
        },
      });
    },
    newSession: () => {
      const now = depsRef.current.now();
      store.runId = `session-${now}`;
      store.sourceText = '';
      store.utteranceOpen = false;
      store.settled.clear();
      store.failedThisUtterance = false;
      store.lastUtteranceFailed = false;
      store.dropped = 0;
      store.blind = emptyBlind();
      store.router.stopAll();
      store.arms.clear();
      dispatch({ type: 'NEW_SESSION', now });
      if (!store.captureHandle) void requestCapture();
    },
    requestMode: (mode) => {
      const s = stateRef.current;
      if (s.mode === mode) return;
      dispatch({
        type: 'REQUEST_SWITCH',
        kind: 'mode',
        label: mode === 'realtime' ? 'Realtime' : 'Cascade',
        patch: { mode },
      });
    },
    cycleLanguage: () => {
      const s = stateRef.current;
      const next = (s.langIdx + 1) % pairs.length;
      const p = pairs[next]!;
      dispatch({
        type: 'REQUEST_SWITCH',
        kind: 'language',
        label: `${p.src} → ${p.tgt}`,
        patch: { langIdx: next, reversed: false },
      });
    },
    swapDirection: () => {
      const s = stateRef.current;
      const p = pairs[s.langIdx]!;
      const reversed = !s.reversed;
      const src = reversed ? p.tgt : p.src;
      const tgt = reversed ? p.src : p.tgt;
      dispatch({
        type: 'REQUEST_SWITCH',
        kind: 'direction',
        label: `${src} → ${tgt}`,
        patch: { reversed },
      });
    },
    setAutoplay: (value) => dispatch({ type: 'SET_AUTOPLAY', value }),
    addArm: () => {
      const s = stateRef.current;
      if (s.arms.length >= 3) return;
      const next = ADD_ORDER.find((id) => !s.arms.includes(id));
      if (next) {
        store.blind = emptyBlind(); // arm set changed — any open draw is stale
        dispatch({ type: 'ADD_ARM', armId: next });
      }
    },
    removeArm: (armId) => {
      store.blind = emptyBlind(); // arm set changed — any open draw is stale
      dispatch({ type: 'REMOVE_ARM', armId });
    },
    togglePlay: togglePlayArm,
    reconnect: () => {
      dispatch({ type: 'RECONNECT_CLICKED' });
      for (const id of store.router.armIds) {
        const transport = store.router.getArm(id);
        const def = catalogById.get(id);
        if (transport && def) void transport.start(buildConfig(def));
      }
    },
    toggleBlind: () => {
      if (store.blind.open) {
        store.blind = emptyBlind();
        bump();
        return;
      }
      const s = stateRef.current;
      // Fisher–Yates over the ACTIVE arm order, consuming exactly N−1 rng()
      // values (two arms → one value: < 0.5 keeps the order, >= 0.5 swaps).
      const rng = depsRef.current.rng ?? Math.random;
      const order = [...s.arms];
      for (let i = 0; i < order.length - 1; i++) {
        const j = Math.min(i + Math.floor(rng() * (order.length - i)), order.length - 1);
        const tmp = order[i]!;
        order[i] = order[j]!;
        order[j] = tmp;
      }
      const now = depsRef.current.now();
      store.drawCounter += 1;
      const id = `draw-${now}-${store.drawCounter}`;
      // Recorded AT OPEN TIME so the drawn assignment is auditable even if
      // the rater never submits. The draw attaches to the last settled
      // utterance's record id, tying it to the session run in exportRuns().
      depsRef.current.ledger.recordBlindDraw({
        id,
        utteranceId: `utt-${Math.max(0, s.utteranceCount - 1)}`,
        order: [...order],
        createdAt: now,
      });
      store.blind = {
        open: true,
        drawId: id,
        order,
        scores: { A: null, B: null },
        revealed: false,
      };
      bump();
    },
    scoreBlind: (sample, score) => {
      if (!store.blind.open || store.blind.revealed) return;
      store.blind.scores[sample] = score;
      bump();
    },
    submitBlind: () => {
      const blind = store.blind;
      if (!blind.open || blind.drawId === null || blind.revealed) return;
      const scores: { [sample: string]: number } = {};
      if (blind.scores.A !== null) scores.A = blind.scores.A;
      if (blind.scores.B !== null) scores.B = blind.scores.B;
      depsRef.current.ledger.recordBlindScores({
        drawId: blind.drawId,
        scores,
        revealedAt: depsRef.current.now(),
      });
      blind.revealed = true;
      bump();
    },
    playBlindSample: (sample) => {
      const armId = store.blind.order[sample === 'A' ? 0 : 1];
      if (armId) togglePlayArm(armId);
    },
  };

  const activeArms = state.arms
    .map((id) => catalogById.get(id))
    .filter((d): d is ArmDef => d !== undefined);

  const nextAddableId =
    state.arms.length < 3 ? ADD_ORDER.find((id) => !state.arms.includes(id)) : undefined;
  const nextArm = nextAddableId ? (catalogById.get(nextAddableId) ?? null) : null;

  const armViews: Record<string, ArmUtteranceView> = {};
  for (const id of state.arms) armViews[id] = store.arms.get(id)?.view ?? emptyView();

  const footer: SessionFooterData = {
    utterances: state.utteranceCount,
    p50Ms: null,
    p95Ms: null,
    costUsd: 0,
  };
  if (store.runId) {
    const agg = depsRef.current.ledger.aggregates(store.runId);
    for (const arm of Object.values(agg.perArm)) {
      footer.costUsd += arm.costUsd;
      if (arm.p50Ms !== null) {
        footer.p50Ms = footer.p50Ms === null ? arm.p50Ms : Math.max(footer.p50Ms, arm.p50Ms);
      }
      if (arm.p95Ms !== null) {
        footer.p95Ms = footer.p95Ms === null ? arm.p95Ms : Math.max(footer.p95Ms, arm.p95Ms);
      }
    }
  }

  const elapsedMs =
    state.startedAt === null ? 0 : (state.stoppedAt ?? depsRef.current.now()) - state.startedAt;

  const blind: BlindSlice = {
    open: store.blind.open,
    revealed: store.blind.revealed,
    order: [...store.blind.order],
    scores: { ...store.blind.scores },
    lastUtteranceFailed: store.lastUtteranceFailed,
  };

  return {
    state,
    sourceText: store.sourceText,
    level: store.level,
    activeArms,
    nextArm,
    armViews,
    footer,
    elapsedMs,
    blind,
    actions,
  };
}
