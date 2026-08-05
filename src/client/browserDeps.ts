/**
 * Ticket 012 — production SessionDeps built from the real browser.
 *
 * Used only when <App /> is rendered without an injected deps bag
 * (main.tsx). Tests always inject fakes, so this module is deliberately
 * untested: real transports (RealtimeTransport over WebRTC,
 * CascadeTransport over WS with a window.location-derived base URL), real
 * getUserMedia capture through startCapture, real AudioContexts for
 * playback, a localStorage-backed RunLedger, and Date.now.
 */

import { startCapture, type CapturePipeline, type CaptureResult } from './audio/capture';
import type { PlaybackAudioContextLike } from './audio/playback';
import { RunLedger } from './state/ledger';
import { CascadeTransport, type WsLike } from './transport/cascade';
import { RealtimeTransport, type RtcPeerConnectionLike } from './transport/realtime';
import type { InterpreterTransport } from './transport/types';
import type { ArmDef, CaptureCallbacks, SessionDeps } from './views/useSessionController';

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

export function buildBrowserDeps(): SessionDeps {
  const wsBase = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

  // Live getUserMedia stream captured as it is granted, so RealtimeTransport
  // can attach the mic track to its RTCPeerConnection before createOffer
  // (controller starts transports only after the grant, and reconnects
  // re-read this on every connect). Exercised by browser QA, not unit tests.
  let liveMicStream: MediaStream | null = null;

  const transportFactory = (def: ArmDef): InterpreterTransport => {
    if (def.mode === 'realtime') {
      return new RealtimeTransport(
        { armId: def.id, label: def.label, costPerMinUsd: def.costPerMinUsd },
        {
          fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
            fetch(input, init)) as typeof fetch,
          rtcFactory: () => new RTCPeerConnection() as unknown as RtcPeerConnectionLike,
          now: () => Date.now(),
          getMediaStream: () => liveMicStream,
        },
      );
    }
    return new CascadeTransport(
      {
        armId: def.id,
        label: def.label,
        costPerMinUsd: def.costPerMinUsd,
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
  };
}
