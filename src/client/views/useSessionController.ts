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
 * - Playback: one ArmPlayback for the session, autoplay ALWAYS on. TICKET 040:
 *   realtime audio arrives on the WebRTC media track and never as PCM, so
 *   ArmPlayback is empty for a realtime session and the sound is the media
 *   element the transport attaches the track to; cascade keeps moving the
 *   queue. TICKET 047: LIVE HAS NO PAUSE STATE. There is no play/pause action
 *   on this surface and no code path here suspends playback or the sink —
 *   pausing a live feed is not replay (cascade would schedule into a frozen
 *   clock and play LATE; realtime would simply lose what arrived), and the
 *   PRD says "Live: autoplay on", unconditionally.
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
 *   via deriveLiveCascadeIntervals / deriveLiveRealtimeIntervals in the view.
 *   TICKET 051: onTiming is NOT the only source — the cascade server sends no
 *   `stage.timing` message at all, so a completion record's `timings` are
 *   merged into the card's marks in onUtteranceComplete.
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
import {
  COST_NOT_MEASURED_CELL,
  PRICING_VERSION,
  costFromStored,
  costSlope,
  formatCostUsd,
  priceRealtimeUsage,
  sumMeasuredCosts,
} from '../../core/pricing';
import { anchoredLatencyMs } from '../../core/timing';
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
import type { LiveSessionsClient } from '../replay/recordingsClient';
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
   * TICKET 041 (OPTIONAL) — where a finished LiveSession is PERSISTED. The
   * ledger write happens first and unconditionally; this POSTs the very same
   * record to /api/live-sessions, exactly as App's `recordBlindComparison`
   * does for a judgement (ticket 023). A rejected POST is swallowed: an
   * unreachable server costs the server's copy and nothing else.
   *
   * A host that supplies no client keeps exactly the old behaviour.
   */
  liveSessions?: Pick<LiveSessionsClient, 'create'>;
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
  /** TICKET 052 — `null` is NOT MEASURED. The footer renders it as such. */
  costUsd: number | null;
  /** Pre-rendered through the ONE formatter, so no view can invent `$0.00`. */
  costCell: string;
  /**
   * TICKET 052 R2 — records behind the figure, from the LEDGER AGGREGATE's
   * `count`. Deliberately NOT `utterances` (the session's live turn counter):
   * the two are different quantities and conflating them puts a denominator
   * under a numerator it does not belong to.
   */
  costRecords: number;
  /**
   * How many of them carried a price. `priceRealtimeUsage` returns null PER
   * TURN whenever a `response.done` omits usage, so `$0.041 over 3 of 5` and
   * `$0.041 over 5 of 5` are different claims the dollars cannot separate.
   */
  measuredCostRecords: number;
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
  /**
   * TICKET 049 — true while translated audio cannot be sounded because the
   * AudioContext could not be constructed. A SURFACED, non-fatal state: the
   * session keeps running and keeps measuring; only the sound is missing.
   *
   * ROUND 2 — "while", not "once". This is the latch GATED by the session on
   * screen: false for a realtime session (whose audio is audible on the
   * `remoteAudioSink` element) and false once the session has stopped, because
   * the notice's own copy would be a lie in both. See `playbackNotice`.
   */
  playbackUnavailable: boolean;
  /**
   * TICKET 049 ROUND 2 (STUB) — the BROWSER'S own words for why, as
   * `${name}: ${message}`; null when playback is fine. It exists only on the
   * error the `onPlaybackUnavailable` callback carries, which is what makes
   * that seam load-bearing rather than decorative.
   */
  playbackUnavailableReason: string | null;
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

// ---------------------------------------------------------------------------
// TICKET 051 / 052 — Arm A's Live cost, METERED from `response.done`.
//
// The rate table, the input/output split, the text and cached sub-meters and
// the "unmeasured is not zero" rule ALL live in src/core/pricing.ts now. This
// file used to carry its own copy (`realtimeUsdFromUsage`), which is exactly
// the two-pricing-paths problem ticket 052 exists to end: that copy added
// cached tokens ON TOP of the audio tokens they are a subset of, billing cached
// input at $32.40/M — dearer than uncached — and nothing else in the app could
// have disagreed with it, because nothing else priced anything.
// ---------------------------------------------------------------------------

/**
 * WHEN a Live utterance happened, for the purpose of placing it in a minute
 * bucket. `audio_queued` is the turn's last observable instant and the one every
 * completed utterance carries; the endpointer marks are the fallback for a turn
 * that produced no output audio. Null when nothing on the record says when.
 */
function utteranceInstant(timings: Record<string, number | null>): number | null {
  for (const key of ['audio_queued', 'server_speech_stopped', 'vad_fired', 'speech_end']) {
    const value = timings[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
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
  /**
   * TICKET 049 R2-3 — the BROWSER'S own words for the playback failure,
   * `${name}: ${message}`. It exists ONLY on the error `onPlaybackUnavailable`
   * carries, which is what makes that seam load-bearing: `onAudio` bumps the
   * render either way, so without this the wiring could be deleted unnoticed.
   */
  playbackFailureReason: string | null;
}

/** The browser's own words, never ours. */
function describePlaybackError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
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
      // TICKET 049 — a chunk that could not be sounded is a SURFACED, non-fatal
      // state, never a silent swallow and never a thrown error out of the
      // transport's onAudio callback. Re-render so LiveView raises the notice;
      // nothing about the session, the ledger or the timings changes.
      //
      // ROUND 2 (R2-3) — and CAPTURE THE BROWSER'S REASON. This callback is the
      // only place the error object exists, so the reason row on screen is what
      // makes this wiring load-bearing rather than decorative.
      onPlaybackUnavailable: (error) => {
        store.playbackFailureReason = describePlaybackError(error);
        bump();
      },
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
      playbackFailureReason: null,
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
        // R2-4 — NAME WHAT THE RECORD ACTUALLY CARRIES. Option (c) never stamps
        // `speech_end` in Live, so 'vad' was a false claim in a persisted,
        // exported field — and a blanket 'none' would be just as false for a
        // record that does carry the mark.
        speechEndSource: target.timings.speech_end === undefined ? 'none' : 'vad',
        providers: { ...REALTIME_PROVIDERS },
        // TICKET 052 — metered through the ONE cost model. `null` when the
        // transport reported no usage: NOT MEASURED, never a $0.00 turn.
        costUnits: priceRealtimeUsage(
          completion.usage,
          runConfigRef.current.realtimeModel ?? REALTIME_MODEL,
        ).usd,
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
        // TICKET 051 — THE COMPLETION IS WHERE CASCADE'S MARKS ARRIVE. The
        // server sends no `stage.timing` message at all (src/server/ws.ts), so
        // the whole cascade timings map reaches the client exactly once, on the
        // completion record. Merging it here — rather than relying on the
        // `onTiming` stream, which production never feeds — is what makes the
        // stage rows non-blank in a real Live cascade session. Marks that DID
        // stream in (the realtime transport's, and any fixture's) are kept:
        // whatever the completion carries wins for the keys it names.
        if (e.record.timings) {
          store.target.timings = {
            ...store.target.timings,
            ...(e.record.timings as Record<string, number>),
          };
        }
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
   * TICKET 052 R2 — the session's spend bucketed BY WALL-CLOCK MINUTE, then read
   * as PRD §8's cost slope: $/min in minute 1 against $/min in the final minute.
   *
   * Buckets are placed by each utterance's own marks, not by arrival order, so
   * a turn that completed at 02:50 lands in minute 3 however late the record was
   * assembled. A bucket nobody priced is UNMEASURED, never 0 — a zero slope is
   * the claim that the cost curve is FLAT, which is the finding under test.
   */
  const perMinuteCosts = (
    startedAt: number,
    endedAt: number,
  ): { perMinuteMinute1: number | null; perMinuteFinalMinute: number | null } => {
    const durationMs = Math.max(0, endedAt - startedAt);
    const minutes = Math.max(1, Math.ceil(durationMs / 60_000));
    // A session shorter than two minutes has no final minute to compare minute
    // 1 against; `costSlope` says so by returning nulls rather than a flat 0.
    const buckets: Array<Array<number | null>> = Array.from({ length: minutes }, () => []);

    for (const u of store.utterances) {
      const at = utteranceInstant(u.timings);
      if (at === null) continue;
      const index = Math.floor((at - startedAt) / 60_000);
      if (index < 0 || index >= minutes) continue;
      buckets[index]!.push(u.costUsd);
    }

    const slope = costSlope(
      buckets.map((bucket) => costFromStored(sumMeasuredCosts(bucket.map(costFromStored)).usd)),
    );
    return {
      perMinuteMinute1: slope.minute1UsdPerMin,
      perMinuteFinalMinute: slope.finalMinuteUsdPerMin,
    };
  };

  /**
   * The metrics-only soak record. NO audio-bearing field exists on the stored
   * shape — audio is discarded by construction. `quality.wer` is null because
   * free conversation has no reference transcript.
   */
  const saveLiveSession = (startedAt: number, endedAt: number): void => {
    const config = runConfigRef.current;
    const cascade = config.architecture === 'cascade';
    // TICKET 051 — the SAME anchor the ledger and the footer use: `speech_end`
    // when the corpus supplied one, otherwise the endpointer's decision. A Live
    // session has no ground truth, so anchoring on `speech_end` alone left every
    // saved LiveSession with `latency.p50: null`.
    const latencies = store.utterances
      .map((u) => anchoredLatencyMs(u.timings))
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
      // TICKET 052 R2 — the price source this session's figures were computed
      // under. A session with no stamp was written before a cost model existed
      // and its zeros are absences, not measurements (see `LiveSession`).
      pricingVersion: PRICING_VERSION,
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
        // TICKET 052 — measured utterances only, so a session whose utterances
        // could not be priced reports `null` (not measured) rather than a free
        // session. A session that produced NO UTTERANCE is a different fact and
        // keeps ticket 041's 0: there was nothing to price, and the session is
        // excluded from every figure by `isAggregatableLiveSession` anyway.
        totalUsd:
          store.utterances.length === 0
            ? 0
            : sumMeasuredCosts(store.utterances.map((u) => costFromStored(u.costUsd))).usd,
        // TICKET 052 R2 (PRD §8) — THE COST SLOPE, the finding for Arm A.
        // Realtime replays the accumulated conversation each turn, so $/min
        // CLIMBS with session length; a ≤1-minute clip cannot show it, which is
        // one of the reasons Live exists at all and Replay cannot answer this.
        ...perMinuteCosts(startedAt, endedAt),
      },
      stability: {
        utterancesCompleted: store.utterances.length,
        disconnects: store.disconnects,
        heapStart: null,
        heapEnd: null,
      },
      quality: { wer: null },
    };
    // LOCAL FIRST, UNCONDITIONALLY. The operator's take is not made contingent
    // on a reachable server (ticket 023's order exactly).
    depsRef.current.ledger.appendLiveSession(session);
    // TICKET 041 — then the SAME record to the server, so the stability
    // artifact reaches data/, the exported bundle and a second machine. A
    // rejection is swallowed: it costs the server's copy and nothing else, and
    // the view stays usable. A session that produced NOTHING is posted too —
    // storing is not aggregating, and deleting the record of a take that failed
    // to produce anything would delete the finding.
    void depsRef.current.liveSessions?.create(session).catch(() => {});
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
    const costUsd = sumMeasuredCosts(
      Object.values(agg.perArm).map((a) => costFromStored(a.costUsd)),
    ).usd;
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
        // THE MICROPHONE COMES FIRST. `requestCapture()` returns synchronously
        // (it kicks off a promise), so the resume below still runs in this same
        // handler tick and keeps the user gesture — but nothing it does can
        // stop the mic request from being issued.
        void requestCapture();
        // TICKET 047 (round 2) — the ONLY `ctx.resume()` in the client. An
        // AudioContext built under an autoplay policy can start `suspended`,
        // and with Live's play control deleted there is no affordance left to
        // recover it by hand, so the resume happens HERE: inside the real user
        // gesture that started the session, where the browser honours it. This
        // is not a control — there is nothing to press and nothing to un-press.
        //
        // ROUND 3 — and it is BEST-EFFORT. `play()` constructs the AudioContext
        // synchronously, and `new AudioContext()` throws for real: Chrome at
        // its per-document context limit (reachable after a Replay QA pass —
        // `playRun`/`playTake` build one per press and never close it), Safari
        // under some policy states. Ordered first and unguarded, that throw
        // escaped into a React event handler, `startCapture` was never called,
        // and the session sat in 'requesting' forever with no denied card and
        // no retry that could help: Live silently dead. A failed resume costs
        // at worst silent cascade audio — the thing this line exists to make
        // less likely — so it must never cost the microphone.
        try {
          store.playback.play();
        } catch {
          /* autoplay-policy recovery is best-effort; the session still runs */
        }
      }
    },
    stop: () => stopRef.current(),
    newSession: () => {
      const now = depsRef.current.now();
      store.runId = `session-${now}`;
      resetSessionStore();
      // TICKET 049 R2-6 — a new session is the operator saying "try again", and
      // it is the ONLY place the playback latch is dropped. A context cap frees
      // when some other context closes and Safari's policy state changes, so a
      // transient failure must not require reloading the tab; but `reset()` —
      // the next utterance — still retries nothing, because between two
      // sentences of one session nothing has changed.
      store.playback.clearPlaybackFailure();
      store.playbackFailureReason = null;
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
    // TICKET 047 — there is deliberately no play/pause action here. Live's
    // ArmPlayback runs `autoplay: true` and the realtime sink autoplays the
    // attached track, so the translation sounds the moment it arrives.
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
    // TICKET 052 — null until a MEASURED cost arrives. `$0.00` on a live
    // session reads as "this configuration is free", which is the one claim
    // the footer must never make.
    costUsd: null,
    costCell: COST_NOT_MEASURED_CELL,
    costRecords: 0,
    measuredCostRecords: 0,
  };
  if (store.runId) {
    const agg = depsRef.current.ledger.aggregates(store.runId);
    for (const arm of Object.values(agg.perArm)) {
      if (arm.costUsd !== null) footer.costUsd = (footer.costUsd ?? 0) + arm.costUsd;
      footer.costRecords += arm.count;
      footer.measuredCostRecords += arm.measuredCostRecords;
      if (arm.p50Ms !== null) {
        footer.p50Ms = footer.p50Ms === null ? arm.p50Ms : Math.max(footer.p50Ms, arm.p50Ms);
      }
      if (arm.p95Ms !== null) {
        footer.p95Ms = footer.p95Ms === null ? arm.p95Ms : Math.max(footer.p95Ms, arm.p95Ms);
      }
    }
  }
  footer.costCell = formatCostUsd(footer.costUsd);

  const elapsedMs =
    state.startedAt === null ? 0 : (state.stoppedAt ?? depsRef.current.now()) - state.startedAt;

  /**
   * TICKET 049 ROUND 2 — the notice must not outlive the thing it describes.
   * The latch says "a chunk was dropped"; whether that is still TRUE OF THE
   * SESSION ON SCREEN is a separate question, and it is answered here rather
   * than in the view because it is made of session facts the controller owns.
   *
   * - `mode === 'cascade'` (R2-1). Live's mode buttons are never disabled and a
   *   switch at 'ready' applies immediately. Realtime audio rides the
   *   `remoteAudioSink` element and is AUDIBLE, so the notice is simply false
   *   there. This is a GATE, not a latch reset: switching back to cascade must
   *   restore it, because the context is still unbuildable and cascade audio is
   *   still silent. (Clearing the latch on a mode switch loses it for good.)
   * - a STOPPABLE status (R2-2). The copy says the session "is still running
   *   and still being measured"; once status is 'stopped' or 'idle' that is a
   *   falsehood, and the stopped summary is what the operator reads instead.
   */
  const playbackNotice =
    store.playback.playbackUnavailable &&
    state.mode === 'cascade' &&
    STOPPABLE_STATUSES.includes(state.status);

  return {
    state,
    sourceText: store.sourceText,
    level: store.level,
    armTag: deriveArmTag(runConfig),
    runConfig,
    target: store.target,
    footer,
    elapsedMs,
    playbackUnavailable: playbackNotice,
    playbackUnavailableReason: playbackNotice ? store.playbackFailureReason : null,
    actions,
  };
}
