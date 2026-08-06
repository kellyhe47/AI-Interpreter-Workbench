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
 */

import { readWav } from '../harness/wav';
import { startCapture, type CapturePipeline, type CaptureResult } from './audio/capture';
import { ArmPlayback, type PlaybackAudioContextLike } from './audio/playback';
import { createRunOnceExecutor, startBatch, type BatchHandle } from './batch/runner';
import {
  createRecordingsClient,
  createRunsClient,
  type RecordingsClient,
  type RunsClient,
} from './replay/recordingsClient';
import { runOnce, type RunnerDeps, type RunOnceConfig, type RunOnceResult } from './replay/runner';
import { RunLedger } from './state/ledger';
import { CascadeTransport, type WsLike } from './transport/cascade';
import { RealtimeTransport, type RtcPeerConnectionLike } from './transport/realtime';
import type { InterpreterTransport } from './transport/types';
import type { ReplayBatchRequest, ReplayDeps, ReplayRunRequest } from './views/ReplayView';
import type { CaptureCallbacks, LiveRunConfig, SessionDeps } from './views/useSessionController';

/** The production bag: SessionDeps plus the Replay seams. Assignable to AppDeps. */
export interface BrowserDeps extends SessionDeps {
  replay: ReplayDeps;
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

  // Replay has no microphone: the clip is paced INTO the transport, so the
  // realtime peer connection carries no live track (getMediaStream omitted).
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
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  };
}

export function buildBrowserDeps(): BrowserDeps {
  const wsBase = websocketBase();

  // Live getUserMedia stream captured as it is granted, so RealtimeTransport
  // can attach the mic track to its RTCPeerConnection before createOffer
  // (controller starts transports only after the grant, and reconnects
  // re-read this on every connect). Exercised by browser QA, not unit tests.
  let liveMicStream: MediaStream | null = null;

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
    ledger: new RunLedger(window.localStorage),
    now: () => Date.now(),
    replay: buildReplayDeps(),
  };
}
