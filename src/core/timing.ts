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

// ---------------------------------------------------------------------------
// TICKET 051 — the LIVE anchor
//
// `speech_end` is CORPUS GROUND TRUTH: the operator-annotated instant the human
// stopped speaking. Only Replay's manifest has it. Nothing in a browser knows
// when the human stopped — only when the endpointer DECIDED they had — so Live
// anchors on that decision instead:
//   realtime -> `server_speech_stopped`   cascade -> `vad_fired`
// Both are rendered as "detected end of speech", which is exactly what they are.
//
// `speech_end` ALWAYS WINS when present, so no Replay figure moves. And when no
// anchor is present at all the answer is null, never 0 and never back-derived:
// `first_audio_delta` (which does not exist over WebRTC — ticket 040) must not
// rescue a record into carrying a figure its transport cannot produce.
// ---------------------------------------------------------------------------

/** Loosest read-only view of a timings map, as the ledger stores them. */
export type TimingMarks = Readonly<Record<string, number | null | undefined>>;

function mark(t: TimingMarks | undefined, name: string): number | undefined {
  const v = t?.[name];
  return typeof v === 'number' ? v : undefined;
}

/**
 * The instant Live calls "detected end of speech": the endpointer's decision.
 * NOT the same quantity as `speech_end`, which is why it is never labelled so.
 */
export function detectedEndOfSpeechMs(t: TimingMarks | undefined): number | undefined {
  return mark(t, 'vad_fired') ?? mark(t, 'server_speech_stopped');
}

/**
 * The one perceived-latency sample for a record, under whichever anchor the
 * record actually carries. Corpus ground truth first (REPLAY, unmoved), the
 * endpointer's decision second (LIVE), null otherwise.
 */
export function anchoredLatencyMs(t: TimingMarks | undefined): number | null {
  const audioQueued = mark(t, 'audio_queued');
  if (audioQueued === undefined) return null;
  const anchor = mark(t, 'speech_end') ?? detectedEndOfSpeechMs(t);
  if (anchor === undefined) return null;
  return audioQueued - anchor;
}

/**
 * Live's cascade spans — the three the client can actually observe, plus the
 * total they sum to. `tts_first_byte` is deliberately NOT a boundary here: the
 * observable span is "translated text -> audio ready", and splitting it at the
 * first synthesized byte would put a row on screen that names no event the
 * operator can reason about.
 */
export interface LiveCascadeIntervals {
  /** stt_final - vad_fired — detected end of speech -> transcript */
  transcribe: number | null;
  /** mt_first_token - stt_final — transcript -> translated text */
  translate: number | null;
  /** audio_queued - mt_first_token — translated text -> audio ready */
  speak: number | null;
  /** audio_queued - vad_fired — the sum of the three */
  total: number | null;
}

/**
 * Live's realtime span. ONE row, because over WebRTC there is exactly one
 * observable instant on either side: the endpointer's decision and the moment
 * the model's audio begins on the media track. `first_audio_delta` is not read
 * here at ALL — `response.output_audio.delta` does not exist on this transport.
 */
export interface LiveRealtimeIntervals {
  /** audio_queued - server_speech_stopped — detected end of speech -> audio ready */
  model: number | null;
  /** identical to `model`: one observable span means one figure */
  total: number | null;
}

export function deriveLiveCascadeIntervals(t: CascadeTimestamps): LiveCascadeIntervals {
  return {
    transcribe: diff(t.stt_final, t.vad_fired),
    translate: diff(t.mt_first_token, t.stt_final),
    speak: diff(t.audio_queued, t.mt_first_token),
    total: diff(t.audio_queued, t.vad_fired),
  };
}

export function deriveLiveRealtimeIntervals(t: RealtimeTimestamps): LiveRealtimeIntervals {
  const model = diff(t.audio_queued, t.server_speech_stopped);
  return { model, total: model };
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
  /**
   * TICKET 052 — metered USD for this utterance, or `null` when it could NOT
   * be metered. `null` is "not measured"; `0` is the claim that the utterance
   * was free, and only one of those is ever true of a real turn.
   */
  costUnits: number | null;
  error?: string;
  corpusId: string;
  runId: string;
}
