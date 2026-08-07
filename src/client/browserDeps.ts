/**
 * Ticket 012/016 — the production deps bag, built from the real browser.
 *
 * Used only when <App /> is rendered without an injected deps bag
 * (main.tsx). Tests always inject fakes, so this module is deliberately
 * untested: real transports (RealtimeTransport over WebRTC,
 * CascadeTransport over WS with a window.location-derived base URL), real
 * getUserMedia capture through startCapture, real AudioContexts for
 * playback, a localStorage-backed RunLedger, and Date.now.
 *
 * TICKET 016 — the bag now also carries `replay`, so the Replay tab is
 * reachable in the actual product and not only under an injected test bag:
 * REST-backed recordings/runs clients (createRecordingsClient /
 * createRunsClient over the ticket-003 endpoints), a `runOnce` bound to a
 * real transport factory, a `startBatch` over createRunOnceExecutor, and a
 * `playRun` that fetches a run's stored WAV and plays it ON DEMAND — never at
 * render, which is the one rule Replay playback has.
 *
 * The three BLIND seams (rng, evaluatorLanguage, recordBlindComparison) are
 * deliberately NOT set here. App supplies them, because it is App that owns
 * the ledger the comparison is persisted into.
 *
 * TICKET 023 — the bag DOES carry `blindComparisons`, the REST client for
 * POST/GET /api/blind-comparisons. It sits here rather than in App for the
 * mirror-image reason: it is a transport, built from the same injected fetch as
 * the recordings/runs clients, and App is what decides to USE it (it writes the
 * ledger and posts the same record). Without it, a submitted score reached
 * localStorage and nothing else — absent from the exported bundle and
 * unreachable from the second machine PRD §10 describes (QA F6).
 *
 * TICKET 019 — the bag also carries `hydrate`, the Results hydration seam, so
 * the real product's Results screen reads the server's Runs instead of an
 * empty browser-local ledger. It is built from the SAME two REST clients the
 * Replay bag holds, but it is a separate field on purpose (see BrowserDeps).
 *
 * FIXTURE MODE GETS NO `hydrate`. `buildFixtureDeps` keeps the real Replay bag
 * — Replay needs no microphone, so there is nothing there for fixture mode to
 * stand in for — but its ledger is a deliberately fresh, in-memory,
 * never-persisted one holding a scripted session. Pulling the server's real
 * measurements into that bag would put genuine figures on screen underneath a
 * fabricated session, and would make `?fixture=1` (a QA and screenshot path)
 * depend on whatever happens to be on the server that day. Fixture mode is for
 * exercising the LIVE journey without a grantable mic; it is not a second
 * production build.
 */

import { CORPUS_VERSION } from '../core/corpus';
import { readWav } from '../harness/wav';
import { startCapture, type CapturePipeline, type CaptureResult } from './audio/capture';
import { ArmPlayback, type PlaybackAudioContextLike } from './audio/playback';
import { createRunOnceExecutor, startBatch, type BatchHandle } from './batch/runner';
import {
  startTake,
  type CaptureDenied,
  type RecordedTake,
  type TakeRecorder,
} from './replay/capture';
import { segmentTake } from './replay/segment';
import {
  createBlindComparisonsClient,
  createLiveSessionsClient,
  createRecordingsClient,
  createRunsClient,
  type BlindComparisonsClient,
  type LiveSessionsClient,
  type RecordingsClient,
  type RunsClient,
} from './replay/recordingsClient';
import { runOnce, type RunnerDeps, type RunOnceConfig, type RunOnceResult } from './replay/runner';
import type { LedgerHydrationSource } from './state/hydrateLedger';
import { RunLedger } from './state/ledger';
import { CascadeTransport, type WsLike } from './transport/cascade';
import {
  RealtimeTransport,
  type RemoteAudioSink,
  type RtcPeerConnectionLike,
} from './transport/realtime';
import type { InterpreterTransport } from './transport/types';
import type {
  ReplayBatchRequest,
  ReplayDeps,
  ReplayRunRequest,
  ReplayTakeOptions,
} from './views/ReplayView';
import type { CaptureCallbacks, LiveRunConfig, SessionDeps } from './views/useSessionController';

/**
 * The production bag: SessionDeps plus the Replay seams and — ticket 019 — the
 * Results hydration seam. Assignable to AppDeps.
 */
export interface BrowserDeps extends SessionDeps {
  replay: ReplayDeps;
  /**
   * TICKET 019 — how Results gets the server's Runs. It reuses the very same
   * REST client instances the Replay bag holds (so both screens read one
   * backend), but it is its OWN field: App must never infer hydration from the
   * presence of `replay`, because "this host can run replays" and "this host
   * wants Results to load from the server" are different statements, and a
   * test bag that wires the first is not asking for the second.
   */
  hydrate: LedgerHydrationSource;
}

/** A batch run that over-runs this is aborted and recorded as a failure. */
const RUN_TIMEOUT_MS = 120_000;

/** ScriptProcessor-based capture pipeline (source -> processor -> emit). */
const browserPipeline: CapturePipeline = ({ context, stream, emit }) => {
  const ctx = context as AudioContext;
  const source = ctx.createMediaStreamSource(stream as MediaStream);
  const processor = ctx.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (ev) => {
    emit(new Float32Array(ev.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(ctx.destination);
  return () => {
    processor.disconnect();
    source.disconnect();
  };
};

/**
 * TICKET 040 — the REAL output for the model's inbound WebRTC audio track.
 *
 * Over WebRTC OpenAI sends the response audio on the media track only, so the
 * one conventional way to hear it is a hidden `<audio>` element carrying the
 * remote MediaStream as `srcObject`; there is no PCM to feed an AudioContext.
 * `autoplay` is what satisfies "audible in Live without pressing anything",
 * and play()/pause() are what make Live's control move the real sound.
 *
 * The element is created lazily and reused across reconnects: attaching a new
 * stream to the same element is exactly the reconnect story, and one element
 * per session keeps a stale one from playing under a fresh one.
 */
function createRemoteAudioSink(): RemoteAudioSink {
  let el: HTMLAudioElement | null = null;
  const element = (): HTMLAudioElement => {
    if (el === null) {
      el = document.createElement('audio');
      el.autoplay = true;
      // Not a control surface: Live's own play/pause button drives it.
      el.controls = false;
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    return el;
  };
  return {
    attach: (stream) => {
      const node = element();
      node.srcObject = stream as unknown as MediaStream;
      // A rejected autoplay is not a failure worth surfacing: the operator
      // still has the play button, which drives this same element.
      void node.play?.().catch(() => {});
    },
    play: () => {
      void element().play?.().catch(() => {});
    },
    pause: () => element().pause(),
  };
}

/** Same-origin ws:// (or wss://) base for the cascade socket. */
function websocketBase(): string {
  return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
}

/** Injected fetch, never captured at module scope. */
const browserFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  fetch(input, init)) as typeof fetch;

/* -------------------------------------------------------------------------
 * Ticket 016 — the REAL Replay bag.
 *
 * Same seams the locked ReplayView tests fake, wired to the actual product:
 * the REST clients over the ticket-003 endpoints, a transport factory that
 * makes `config.realtimeModel` explicit (the transport's own default is the
 * cheap dev model, so a run that let it stand would derive 'ad-hoc' and Arm A
 * would never appear in the ledger), and a playback seam that is only ever
 * called from a click.
 *
 * `rng` / `evaluatorLanguage` / `recordBlindComparison` are intentionally
 * absent: App fills them in, because App owns the ledger they persist into.
 * ---------------------------------------------------------------------- */

export function buildReplayDeps(): ReplayDeps {
  const recordings: RecordingsClient = createRecordingsClient({ fetchImpl: browserFetch });
  const runs: RunsClient = createRunsClient({ fetchImpl: browserFetch });
  // Ticket 023 — the REST seam a submitted blind comparison is persisted
  // through. Same injected fetch and same same-origin default as its two
  // siblings, so the deployed instance needs no extra configuration for a
  // coworker's scores to reach data/ (PRD §7, §10).
  const blindComparisons: BlindComparisonsClient = createBlindComparisonsClient({
    fetchImpl: browserFetch,
  });

  // Replay has no microphone: the clip is paced INTO the transport, so the
  // realtime peer connection carries no live track (getMediaStream omitted).
  // NO `remoteAudioSink` either, and deliberately: NOTHING IN REPLAY AUTOPLAYS
  // (PRD §7), and a sink here would sound the model's track the moment it
  // arrived. The measurement Replay needs comes from the transport's
  // `audio_queued` mark, which is stamped whether or not anything is listening.
  const createTransport = (config: RunOnceConfig): InterpreterTransport => {
    if (config.architecture === 'realtime') {
      return new RealtimeTransport(
        { armId: 'replay', label: 'Realtime', costPerMinUsd: 0, model: config.realtimeModel },
        {
          fetchImpl: browserFetch,
          rtcFactory: () => new RTCPeerConnection() as unknown as RtcPeerConnectionLike,
          now: () => Date.now(),
        },
      );
    }
    return new CascadeTransport(
      { armId: 'replay', label: 'Cascade', costPerMinUsd: 0, baseUrl: websocketBase() },
      { wsFactory: (url: string) => new WebSocket(url) as unknown as WsLike, now: () => Date.now() },
    );
  };

  const runnerDeps: RunnerDeps = {
    recordings,
    runs,
    createTransport,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  };

  return {
    recordings,
    runs,
    blindComparisons,
    runOnce: (request: ReplayRunRequest): Promise<RunOnceResult> =>
      runOnce({
        recordingId: request.recordingId,
        config: request.config,
        deps: runnerDeps,
        signal: request.signal,
      }),
    startBatch: (request: ReplayBatchRequest): BatchHandle =>
      startBatch({
        recordingIds: request.recordingIds,
        configurations: request.configurations,
        reps: request.reps,
        runTimeoutMs: RUN_TIMEOUT_MS,
        deps: { execute: createRunOnceExecutor(runnerDeps), now: () => Date.now() },
        onProgress: request.onProgress,
      }),
    // ON DEMAND ONLY. Fetches the stored WAV and plays it through a fresh
    // context; nothing in Replay ever autoplays, so this is reachable from a
    // click and from nowhere else.
    playRun: (runId: string): void => {
      void runs.getAudio(runId).then((bytes) => {
        const playback = new ArmPlayback({
          audioContextFactory: () => new AudioContext() as unknown as PlaybackAudioContextLike,
          autoplay: false,
        });
        playback.enqueue(readWav(bytes).samples);
        playback.play();
      });
    },
    // Ticket 036 — the record-a-clip seams, bound to the REAL browser. Same
    // getUserMedia path Live uses (audio/capture.ts through replay/capture.ts),
    // so there is still exactly one microphone path in the client.
    startTake: (options: ReplayTakeOptions): Promise<TakeRecorder | CaptureDenied> =>
      startTake({
        getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        audioContextFactory: () => new AudioContext(),
        pipeline: browserPipeline,
        onLevel: options.onLevel,
        onMaxDuration: options.onMaxDuration,
        maxDurationMs: options.maxDurationMs,
      }),
    segmentTake,
    // ON DEMAND ONLY, like playRun: a fresh context per press, never at render.
    playTake: (take: RecordedTake): void => {
      const playback = new ArmPlayback({
        audioContextFactory: () => new AudioContext() as unknown as PlaybackAudioContextLike,
        autoplay: false,
      });
      playback.enqueue(take.samples);
      playback.play();
    },
    corpusVersion: CORPUS_VERSION,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  };
}

export function buildBrowserDeps(): BrowserDeps {
  const wsBase = websocketBase();

  // Built ONCE and shared: `replay` and `hydrate` hand Results and Replay the
  // same two REST clients, which is what makes "one ledger under every view"
  // true of the real product rather than only of the unit tests.
  const replay = buildReplayDeps();

  // Live getUserMedia stream captured as it is granted, so RealtimeTransport
  // can attach the mic track to its RTCPeerConnection before createOffer
  // (controller starts transports only after the grant, and reconnects
  // re-read this on every connect). Exercised by browser QA, not unit tests.
  let liveMicStream: MediaStream | null = null;

  // TICKET 040 — the Live output for the model's inbound track. ONE sink for
  // the session: it is handed to every realtime transport the factory builds
  // (so a reconnect re-attaches to the same element) and to the controller, so
  // the play/pause control moves exactly the audio the operator is hearing.
  const remoteAudioSink = createRemoteAudioSink();

  // TICKET 041 — ONE live-sessions client, handed to BOTH seams: the write
  // seam the controller POSTs a finished session through, and the hydration
  // listing Results reads them back from. Built here for the same reason
  // `blindComparisons` is: it is a transport over the same injected fetch, and
  // it is the controller and Results that decide to USE it. A seam nothing
  // wires is a seam that does not exist — which is exactly how twelve real
  // takes ended up reachable from one browser profile and nowhere else.
  const liveSessions: LiveSessionsClient = createLiveSessionsClient({ fetchImpl: browserFetch });

  // Ticket 012 — ONE transport per session, built from the resolved recipe.
  // `config.realtimeModel` is already resolved by the controller (never left
  // to the transport's cheap dev default), so what runs is what the derived
  // arm pill claims.
  const transportFactory = (config: LiveRunConfig): InterpreterTransport => {
    if (config.architecture === 'realtime') {
      return new RealtimeTransport(
        { armId: 'live', label: 'Realtime', costPerMinUsd: 0, model: config.realtimeModel },
        {
          fetchImpl: browserFetch,
          rtcFactory: () => new RTCPeerConnection() as unknown as RtcPeerConnectionLike,
          now: () => Date.now(),
          getMediaStream: () => liveMicStream,
          remoteAudioSink,
        },
      );
    }
    return new CascadeTransport(
      {
        armId: 'live',
        label: 'Cascade',
        costPerMinUsd: 0,
        baseUrl: wsBase,
      },
      {
        wsFactory: (url: string) => new WebSocket(url) as unknown as WsLike,
        now: () => Date.now(),
      },
    );
  };

  return {
    transportFactory,
    startCapture: (cbs: CaptureCallbacks): Promise<CaptureResult> =>
      startCapture({
        getUserMedia: async (constraints) => {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          liveMicStream = stream; // expose to the realtime transport (see above)
          return stream;
        },
        audioContextFactory: () => new AudioContext(),
        pipeline: browserPipeline,
        onChunk: cbs.onChunk,
        onLevel: cbs.onLevel,
      }),
    playbackContextFactory: () => new AudioContext() as unknown as PlaybackAudioContextLike,
    remoteAudioSink,
    ledger: new RunLedger(window.localStorage),
    now: () => Date.now(),
    replay,
    liveSessions,
    hydrate: { recordings: replay.recordings, runs: replay.runs, liveSessions },
  };
}
