/**
 * Canonical timing vocabulary for the workbench.
 * Isomorphic TypeScript — no node/DOM imports.
 *
 * All timestamps are epoch-relative milliseconds (Date.now()).
 */

/** Timestamps captured along the cascade (STT -> MT -> TTS) pipeline. */
export interface CascadeTimestamps {
  speech_end?: number;
  vad_fired?: number;
  stt_final?: number;
  mt_first_token?: number;
  tts_first_byte?: number;
  audio_queued?: number;
}

/** Timestamps captured along the realtime (speech-to-speech) pipeline. */
export interface RealtimeTimestamps {
  speech_end?: number;
  server_speech_stopped?: number;
  first_audio_delta?: number;
  audio_queued?: number;
}

/**
 * Named cascade intervals. Each is null when either endpoint timestamp is
 * missing. When all timestamps are present:
 *   endpointing + stt + mt + tts + queue === endToEnd === audio_queued - speech_end
 */
export interface CascadeIntervals {
  /** vad_fired - speech_end */
  endpointing: number | null;
  /** stt_final - vad_fired */
  stt: number | null;
  /** mt_first_token - stt_final */
  mt: number | null;
  /** tts_first_byte - mt_first_token */
  tts: number | null;
  /** audio_queued - tts_first_byte */
  queue: number | null;
  /** audio_queued - speech_end */
  endToEnd: number | null;
}

/** Named realtime intervals (3 stages + end-to-end). */
export interface RealtimeIntervals {
  /** server_speech_stopped - speech_end */
  endpointing: number | null;
  /** first_audio_delta - server_speech_stopped */
  model: number | null;
  /** audio_queued - first_audio_delta */
  queue: number | null;
  /** audio_queued - speech_end */
  endToEnd: number | null;
}

function diff(later: number | undefined, earlier: number | undefined): number | null {
  if (later === undefined || earlier === undefined) return null;
  return later - earlier;
}

export function deriveCascadeIntervals(t: CascadeTimestamps): CascadeIntervals {
  return {
    endpointing: diff(t.vad_fired, t.speech_end),
    stt: diff(t.stt_final, t.vad_fired),
    mt: diff(t.mt_first_token, t.stt_final),
    tts: diff(t.tts_first_byte, t.mt_first_token),
    queue: diff(t.audio_queued, t.tts_first_byte),
    endToEnd: diff(t.audio_queued, t.speech_end),
  };
}

export function deriveRealtimeIntervals(t: RealtimeTimestamps): RealtimeIntervals {
  return {
    endpointing: diff(t.server_speech_stopped, t.speech_end),
    model: diff(t.first_audio_delta, t.server_speech_stopped),
    queue: diff(t.audio_queued, t.first_audio_delta),
    endToEnd: diff(t.audio_queued, t.speech_end),
  };
}

export type Mode = 'cascade' | 'realtime';

export interface UtteranceRecord {
  id: string;
  arm: string;
  mode: Mode;
  languagePair: string;
  direction: string;
  sourcePartials: string[];
  sourceFinal: string;
  targetPartials: string[];
  targetFinal: string;
  audioState: string;
  audioDurationMs: number;
  timings: CascadeTimestamps | RealtimeTimestamps;
  speechEndSource: 'corpus' | 'vad';
  providers: { stt: string; mt: string; tts: string };
  costUnits: number;
  error?: string;
  corpusId: string;
  runId: string;
}
