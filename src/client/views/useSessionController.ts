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
 *   stops the previous one. The swap is keyed on the SERIALIZED LiveRunConfig
 *   (`transportKey`), so re-renders that do not change the recipe — status
 *   ticks, transcript updates — never churn the connection.
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
 * - THE SAVED LiveSession RECORDS ITS CONTEXT POLICY. Realtime stores the
 *   policy in force AT STOP ('default' | 'trimmed'); cascade stores 'n/a'
 *   POSITIVELY rather than omitting the field, because "this session had no
 *   policy" is a different claim from "this session ran the default one",
 *   and only the second belongs in PRD §8's realtime-default column.
 *
 * Event mapping (transport → machine):
 * - onSourceText 'partial' with a NEW utterance number → SPEECH_DETECTED and
 *   a fresh target card. Partials carry ACCUMULATED text (transport
 *   contract); 'final' replaces the source card text.
 * - onTargetText 'delta' appends, 'final' replaces.
 * - onTiming accumulates the utterance's timestamps; the stage rows derive
 *   via deriveCascadeIntervals / deriveRealtimeIntervals in the view.
 * - onUtteranceComplete / onError SETTLE the utterance (a failure settles it
 *   too, so one dead utterance never wedges the session): ARMS_SETTLED then
 *   UTTERANCE_BOUNDARY, which applies any queued switch and bumps
 *   utteranceCount.
 * - onConnectionState 'reconnecting' → CONNECTION_LOST + RECONNECT_ATTEMPT;
 *   'connected' → RECONNECTED; 'disconnected' → RECONNECT_EXHAUSTED.
 * ==========================================================================
 */

import { useEffect, useReducer, useRef } from 'react';
import {
  DEFAULT_CASCADE_TRIPLE,
  MENUS,
  REALTIME_MODEL,
  deriveArmTag,
  type ArmTag,
  type ProviderTriple,
  type RunConfig,
} from '../../core/arms';
import type { Mode, UtteranceRecord } from '../../core/timing';
import type { CaptureHandle, CaptureResult } from '../audio/capture';
import { ArmPlayback, type ArmPlaybackOptions } from '../audio/playback';
import type { PlaybackAudioContextLike } from '../audio/playback';
import type { LiveContextPolicy, LiveSession, LiveSessionUtterance, RunLedger } from '../state/ledger';
import {
  LIVE_MAX_SESSION_MS,
  createInitialState,
  pairs,
  reduce,
  type ContextPolicy,
  type ProviderStage,
  type SessionState,
  type SessionStatus,
} from '../state/sessionMachine';
import type { RemoteAudioSink } from '../transport/realtime';
import { TransportRouter } from '../transport/router';
import type {
  InterpreterTransport,
  TransportConfig,
  UtteranceCompletion,
} from '../transport/types';

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
  /**
   * TICKET 040 (OPTIONAL) — the realtime WebRTC output sink. Realtime audio
   * arrives on the media track, never as PCM through onAudio, so ArmPlayback
   * holds nothing for a realtime session and `togglePlay` must drive THIS to
   * control real sound. Cascade sessions leave it untouched.
   */
  remoteAudioSink?: RemoteAudioSink;
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

/** Exact opaque-failure copy (matches REALTIME_OPAQUE_ERROR_MESSAGE). */
const OPAQUE_FAILURE_COPY = 'opaque failure — no stage attribution · session still running';

const LANG_CODE: Record<string, string> = { English: 'EN', Spanish: 'ES', Cantonese: 'YUE' };
const LANG_LOWER: Record<string, string> = { English: 'en', Spanish: 'es', Cantonese: 'yue' };

/** The provider names a realtime run advertises (one model does all three). */
const REALTIME_PROVIDERS = {
  stt: 'openai-realtime',
  mt: 'openai-realtime',
  tts: 'openai-realtime',
};

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

/** Statuses during which the elapsed clock advances (and the cap applies). */
const TICKING_STATUSES: readonly SessionStatus[] = [
  'listening',
  'processing',
  'ready',
  'playing',
  'reconnecting',
  'disconnected',
];

function emptyTarget(): TargetView {
  return {
    utt: -1,
    status: 'ready',
    hasData: false,
    targetText: '',
    failMessage: null,
    timings: {},
    durationMs: 0,
  };
}

/** Nearest-rank percentile, matching RunLedger's convention exactly. */
function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.ceil(p * sorted.length) - 1]!;
}

interface ControllerStore {
  router: TransportRouter;
  captureHandle: CaptureHandle | null;
  /** One shared run id per live session (`session-${now}` — prefix is contract). */
  runId: string | null;
  /** Serialized LiveRunConfig the active transport was built from. */
  transportKey: string | null;
  playbackOpts: ArmPlaybackOptions;
  playback: ArmPlayback;
  target: TargetView;
  sourceText: string;
  sourcePartials: string[];
  sourceFinal: string;
  targetPartials: string[];
  /** Highest utterance number opened by a source partial (-1 before any). */
  currentUtt: number;
  utteranceOpen: boolean;
  dropped: number;
  disconnects: number;
  level: number;
  /** Metrics-only utterance rows for the saved LiveSession (NO audio). */
  utterances: LiveSessionUtterance[];
}

export function useSessionController(deps: SessionDeps): SessionController {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const [state, dispatch] = useReducer(reduce, deps, (d: SessionDeps) =>
    createInitialState(d.initialState),
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const [, bump] = useReducer((c: number) => c + 1, 0);

  // The resolved recipe, recomputed every render and mirrored into a ref so
  // transport construction and record stamping never read a stale copy.
  const runConfig: LiveRunConfig = {
    architecture: state.mode,
    // Resolve the pinned snapshot HERE: the transport's own default is the
    // cheap dev model, which correctly derives to 'ad-hoc' and would make the
    // arm pill lie about what is running.
    realtimeModel: REALTIME_MODEL,
    providers: { ...state.providers },
    contextPolicy: state.contextPolicy,
  };
  const runConfigRef = useRef(runConfig);
  runConfigRef.current = runConfig;

  const storeRef = useRef<ControllerStore | null>(null);
  if (storeRef.current === null) {
    const playbackOpts: ArmPlaybackOptions = {
      audioContextFactory: () => depsRef.current.playbackContextFactory(),
      // Live autoplay is unconditional: one architecture collides with nothing.
      autoplay: true,
    };
    const store: ControllerStore = {
      router: new TransportRouter(),
      captureHandle: null,
      runId: null,
      transportKey: null,
      playbackOpts,
      playback: new ArmPlayback(playbackOpts),
      target: emptyTarget(),
      sourceText: '',
      sourcePartials: [],
      sourceFinal: '',
      targetPartials: [],
      currentUtt: -1,
      utteranceOpen: false,
      dropped: 0,
      disconnects: 0,
      level: 0,
      utterances: [],
    };
    storeRef.current = store;

    /** Open a fresh target card when a NEW utterance number appears. */
    const touch = (utt: number | undefined): void => {
      if (utt === undefined) return;
      if (utt > store.target.utt) {
        store.target = { ...emptyTarget(), utt, hasData: true, status: 'in-flight' };
        store.sourcePartials = [];
        store.sourceFinal = '';
        store.targetPartials = [];
        store.playback.reset();
        return;
      }
      if (!store.target.hasData) {
        store.target = { ...store.target, utt, hasData: true, status: 'in-flight' };
      }
    };

    /**
     * Assemble/complete the ledger record. Cascade delivers the server's full
     * record; realtime delivers { utt, usage } and is assembled client-side.
     * `arm` is always overwritten with the DERIVED tag — membership is never
     * declared (PRD §6 22d).
     */
    const assembleRecord = (completion: UtteranceCompletion): UtteranceRecord => {
      const runId = store.runId ?? 'session-unknown';
      const arm = deriveArmTag(runConfigRef.current);
      if (
        completion.id !== undefined &&
        completion.timings !== undefined &&
        completion.providers !== undefined
      ) {
        return { ...(completion as UtteranceRecord), arm, runId };
      }
      const s = stateRef.current;
      const pair = pairs[s.langIdx] ?? pairs[0]!;
      const src = s.reversed ? pair.tgt : pair.src;
      const tgt = s.reversed ? pair.src : pair.tgt;
      const target = store.target;
      return {
        id: `utt-${completion.utt ?? target.utt}`,
        arm,
        mode: s.mode,
        languagePair: `${LANG_CODE[pair.src] ?? pair.src}↔${LANG_CODE[pair.tgt] ?? pair.tgt}`,
        direction: `${LANG_LOWER[src] ?? src}→${LANG_LOWER[tgt] ?? tgt}`,
        sourcePartials: [...store.sourcePartials],
        sourceFinal: store.sourceFinal,
        targetPartials: [...store.targetPartials],
        targetFinal: target.targetText,
        audioState: 'queued',
        audioDurationMs: target.durationMs,
        timings: { ...target.timings } as UtteranceRecord['timings'],
        speechEndSource: 'vad',
        providers: { ...REALTIME_PROVIDERS },
        costUnits: 0,
        corpusId: 'live-mic',
        runId,
      };
    };

    /** One architecture → one settle. A FAILED utterance settles too, so a
     * dead utterance never wedges the session at 'processing'. */
    const settle = (failed: boolean): void => {
      if (!store.utteranceOpen) return;
      store.utteranceOpen = false;
      if (failed) store.dropped += 1;
      dispatch({ type: 'ARMS_SETTLED' });
      dispatch({ type: 'UTTERANCE_BOUNDARY' });
    };

    store.router.setHandlers({
      onSourceText: (e) => {
        touch(e.utt);
        if (e.kind === 'partial') {
          store.sourcePartials.push(e.text);
          if (e.utt > store.currentUtt) {
            store.currentUtt = e.utt;
            store.utteranceOpen = true;
            dispatch({ type: 'SPEECH_DETECTED' });
          }
        } else {
          store.sourceFinal = e.text;
        }
        store.sourceText = e.text;
        bump();
      },
      onTargetText: (e) => {
        touch(e.utt);
        if (e.kind === 'delta') {
          store.targetPartials.push(e.text);
          store.target.targetText += e.text;
        } else {
          store.target.targetText = e.text;
        }
        bump();
      },
      onTiming: (e) => {
        touch(e.utt);
        store.target.timings[e.event] = e.t;
        bump();
      },
      onAudio: (e) => {
        touch(e.utt);
        store.playback.enqueue(e.pcm);
        store.target.durationMs = store.playback.durationMs;
        bump();
      },
      onUtteranceComplete: (e) => {
        touch(e.record.utt);
        const record = assembleRecord(e.record);
        depsRef.current.ledger.append(record);
        // METRICS ONLY — the LiveSession row carries no transcript and no
        // audio, by construction rather than by later redaction.
        store.utterances.push({
          id: record.id,
          timings: { ...record.timings } as Record<string, number | null>,
          costUsd: record.costUnits,
        });
        const failed = store.target.status === 'failed';
        if (!failed) store.target.status = 'ready';
        bump();
        settle(failed);
      },
      onError: (e) => {
        store.target.hasData = true;
        store.target.status = 'failed';
        // Cascade names the stage verbatim; realtime cannot, and says so.
        store.target.failMessage = e.opaque
          ? OPAQUE_FAILURE_COPY
          : `${e.message} — session still running`;
        bump();
        settle(true);
      },
      onConnectionState: (e) => {
        if (e.state === 'reconnecting') {
          if (stateRef.current.status !== 'reconnecting') store.disconnects += 1;
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

  const buildTransportConfig = (): TransportConfig => {
    const s = stateRef.current;
    const pair = pairs[s.langIdx] ?? pairs[0]!;
    const src = s.reversed ? pair.tgt : pair.src;
    const tgt = s.reversed ? pair.src : pair.tgt;
    return {
      languagePair: `${LANG_CODE[pair.src] ?? pair.src}↔${LANG_CODE[pair.tgt] ?? pair.tgt}`,
      direction: `${LANG_LOWER[src] ?? src}→${LANG_LOWER[tgt] ?? tgt}`,
      targetLanguage: tgt,
      providers: s.mode === 'cascade' ? { ...s.providers } : undefined,
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

  /**
   * The metrics-only soak record. NO audio-bearing field exists on the stored
   * shape — audio is discarded by construction. `quality.wer` is null because
   * free conversation has no reference transcript.
   */
  const saveLiveSession = (startedAt: number, endedAt: number): void => {
    const config = runConfigRef.current;
    const cascade = config.architecture === 'cascade';
    const latencies = store.utterances
      .map((u) => {
        const speechEnd = u.timings.speech_end;
        const audioQueued = u.timings.audio_queued;
        return typeof speechEnd === 'number' && typeof audioQueued === 'number'
          ? audioQueued - speechEnd
          : null;
      })
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);

    const session: LiveSession = {
      id: store.runId ?? `session-${startedAt}`,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      architecture: config.architecture,
      providerTriple: cascade ? { ...(config.providers ?? DEFAULT_CASCADE_TRIPLE) } : undefined,
      // Cascade is context-free BY DESIGN: 'n/a' states that positively so a
      // cascade session can never land in PRD §8's realtime-default column.
      contextPolicy: (cascade ? 'n/a' : config.contextPolicy) as LiveContextPolicy,
      modelSnapshots: cascade
        ? { ...(config.providers ?? DEFAULT_CASCADE_TRIPLE) }
        : { realtime: config.realtimeModel ?? REALTIME_MODEL },
      utterances: store.utterances.map((u) => ({ ...u, timings: { ...u.timings } })),
      latency: {
        p50: latencies.length === 0 ? null : nearestRank(latencies, 0.5),
        p95: latencies.length === 0 ? null : nearestRank(latencies, 0.95),
        driftMinute1ToEnd: null,
      },
      cost: {
        totalUsd: store.utterances.reduce((sum, u) => sum + u.costUsd, 0),
        perMinuteMinute1: null,
        perMinuteFinalMinute: null,
      },
      stability: {
        utterancesCompleted: store.utterances.length,
        disconnects: store.disconnects,
        heapStart: null,
        heapEnd: null,
      },
      quality: { wer: null },
    };
    depsRef.current.ledger.appendLiveSession(session);
  };

  const stopSession = (): void => {
    const s = stateRef.current;
    if (!STOPPABLE_STATUSES.includes(s.status)) return;
    const now = depsRef.current.now();
    dispatch({ type: 'STOP', now });
    store.captureHandle?.stop();
    store.captureHandle = null;
    store.router.stop();
    store.transportKey = null;

    const startedAt = s.startedAt ?? now;
    const agg = depsRef.current.ledger.aggregates(store.runId ?? '');
    const costUsd = Object.values(agg.perArm).reduce((sum, a) => sum + a.costUsd, 0);
    dispatch({
      type: 'FLUSH_DONE',
      summary: {
        elapsedMs: now - startedAt,
        utterances: s.utteranceCount,
        dropped: store.dropped,
        costUsd,
      },
    });
    if (s.startedAt !== null) saveLiveSession(s.startedAt, now);
  };
  const stopRef = useRef(stopSession);
  stopRef.current = stopSession;

  const resetSessionStore = (): void => {
    store.target = emptyTarget();
    store.sourceText = '';
    store.sourcePartials = [];
    store.sourceFinal = '';
    store.targetPartials = [];
    store.currentUtt = -1;
    store.utteranceOpen = false;
    store.dropped = 0;
    store.disconnects = 0;
    store.utterances = [];
    store.playback.reset();
  };

  // ---------------------------------------------------------------------
  // Transport reconciliation: while the session is live the router holds
  // exactly ONE started transport, built from the current recipe. A recipe
  // change (mode, per-stage provider, context policy) swaps it; the router
  // stops the outgoing one and drops its late events.
  // ---------------------------------------------------------------------
  const transportKey = JSON.stringify(runConfig);
  useEffect(() => {
    if (!TRANSPORT_STATUSES.includes(state.status)) return;
    if (store.transportKey === transportKey && store.router.active) return;
    store.transportKey = transportKey;
    // A replacement transport numbers its utterances from 0 again — reset the
    // utterance tracking so its first utterance opens a fresh card normally.
    store.currentUtt = -1;
    store.utteranceOpen = false;
    store.target = emptyTarget();
    const transport = depsRef.current.transportFactory(runConfigRef.current);
    store.router.setTransport(transport);
    void transport.start(buildTransportConfig());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, transportKey]);

  // Elapsed ticker + the 5-minute cap. The cap is enforced here rather than in
  // the machine because it is a wall-clock fact, and the machine is pure.
  useEffect(() => {
    if (!TICKING_STATUSES.includes(state.status)) return;
    const timer = setInterval(() => {
      const s = stateRef.current;
      if (s.startedAt !== null && depsRef.current.now() - s.startedAt >= LIVE_MAX_SESSION_MS) {
        stopRef.current();
      } else {
        bump();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [state.status]);

  const actions: SessionActions = {
    start: () => {
      const s = stateRef.current;
      const fresh = s.status === 'idle' && s.micPermission !== 'denied';
      const now = depsRef.current.now();
      dispatch({ type: 'START', now });
      if (fresh) {
        store.runId = `session-${now}`;
        resetSessionStore();
        void requestCapture();
      }
    },
    stop: () => stopRef.current(),
    newSession: () => {
      const now = depsRef.current.now();
      store.runId = `session-${now}`;
      resetSessionStore();
      store.router.stop();
      store.transportKey = null;
      dispatch({ type: 'NEW_SESSION', now });
      if (!store.captureHandle) void requestCapture();
    },
    requestMode: (mode) => {
      if (stateRef.current.mode === mode) return;
      dispatch({
        type: 'REQUEST_SWITCH',
        kind: 'mode',
        label: mode === 'realtime' ? 'Realtime' : 'Cascade',
        patch: { mode },
      });
    },
    cycleLanguage: () => {
      const next = (stateRef.current.langIdx + 1) % pairs.length;
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
    cycleProvider: (stage) => {
      const menu = MENUS[stage];
      const current = stateRef.current.providers[stage];
      const idx = menu.indexOf(current);
      const model = menu[(idx + 1) % menu.length]!;
      dispatch({ type: 'SET_PROVIDER', stage, model });
    },
    setContextPolicy: (value) => dispatch({ type: 'SET_CONTEXT_POLICY', value }),
    togglePlay: () => {
      if (stateRef.current.status === 'playing') {
        store.playback.pause();
        dispatch({ type: 'PLAYBACK_ENDED' });
      } else {
        store.playback.onEnded(() => dispatch({ type: 'PLAYBACK_ENDED' }));
        store.playback.play();
        dispatch({ type: 'PLAY' });
      }
    },
    reconnect: () => {
      dispatch({ type: 'RECONNECT_CLICKED' });
      void store.router.active?.start(buildTransportConfig());
    },
  };

  // Footer figures come from the LEDGER AGGREGATE for this session's run id —
  // never from a hardcoded or illustrative number.
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

  return {
    state,
    sourceText: store.sourceText,
    level: store.level,
    armTag: deriveArmTag(runConfig),
    runConfig,
    target: store.target,
    footer,
    elapsedMs,
    actions,
  };
}
