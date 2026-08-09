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

/**
 * Loosest read-only view of a timings map. Every caller's shape is accepted —
 * the ledger's `Record<string, number | null>`, the two named stamp interfaces,
 * and an absent map — because the anchor rule is one rule everywhere.
 */
export type TimingMarks =
  | Readonly<Record<string, number | null | undefined>>
  | CascadeTimestamps
  | RealtimeTimestamps;

function mark(t: TimingMarks | undefined, name: string): number | undefined {
  const v = (t as Record<string, number | null | undefined> | undefined)?.[name];
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
 * ROUND 2 (R2-1) — THE OTHER END OF THE INTERVAL IS NOT ONE EVENT EITHER.
 *
 * `audio_queued` means DIFFERENT THINGS in the two architectures:
 *   cascade  — re-stamped on every synthesized chunk, last chunk wins
 *              (`orchestrator.ts`) -> the LAST audio, which grows with how long
 *              the sentence is
 *   realtime — stamped ONCE at `output_audio_buffer.started` (`realtime.ts`)
 *              -> the FIRST audio
 * Rendering both under one label, or pooling both into one percentile, compares
 * response time against playout duration: a long cascade utterance then looks
 * several times slower than a short Arm A one, and most of the gap is sound
 * still playing.
 *
 * So the interval ENDS AT THE FIRST AUDIO: `tts_first_byte` when the record
 * carries it, `audio_queued` otherwise (realtime has no synthesis stage to
 * stamp, and its `audio_queued` already IS the first audio).
 */
export function firstAudioMs(t: TimingMarks | undefined): number | undefined {
  return mark(t, 'tts_first_byte') ?? mark(t, 'audio_queued');
}

/** Which end-of-speech instant a record's latency sample is anchored on. */
export type LatencyAnchor = 'corpus' | 'detected';

/**
 * The anchor this record's sample WOULD use, or null when it carries none.
 * Exposed so a pool can refuse to mix two quantities under one percentile.
 */
export function latencyAnchorOf(t: TimingMarks | undefined): LatencyAnchor | null {
  if (mark(t, 'speech_end') !== undefined) return 'corpus';
  return detectedEndOfSpeechMs(t) === undefined ? null : 'detected';
}

/**
 * The one perceived-latency sample for a record: FIRST AUDIO minus whichever
 * end-of-speech anchor the record actually carries. Corpus ground truth first
 * (REPLAY, unmoved), the endpointer's decision second (LIVE), null otherwise.
 */
export function anchoredLatencyMs(t: TimingMarks | undefined): number | null {
  const firstAudio = firstAudioMs(t);
  if (firstAudio === undefined) return null;
  const anchor = mark(t, 'speech_end') ?? detectedEndOfSpeechMs(t);
  if (anchor === undefined) return null;
  return firstAudio - anchor;
}

/* ---------------------------------------------------------------------------
 * TICKET 055b — A PHYSICALLY IMPOSSIBLE INTERVAL IS NOT A MEASUREMENT.
 *
 * Perceived latency is `audio_queued − speech_end`: the gap between the speech
 * ending and its translation beginning to sound. Run 7acb0cc9 stored −1435 ms
 * and −2364 ms for two of its four utterances and Results rendered their p50 as
 * `-1.44 s`. An interpreter cannot answer before the speaker has finished, so
 * such a figure is not a fast run — it is the ABSENCE of a measurement, and the
 * two rules below are the one place that judgement is written down.
 *
 * They are deliberately DIFFERENT thresholds, because they answer different
 * questions:
 *
 *  - `isClockInversion` (< 0) — "did these two marks come out in an impossible
 *    ORDER?" That is a defect in how the marks were assigned, and it is refused
 *    at both ends of the pipe: the runner never emits one, the ledger refuses
 *    to store a record carrying one as `complete`.
 *  - `isMeasuredLatencyMs` (> 0) — "is this a quantity we may average?" A ZERO
 *    is not an inversion (nothing came out backwards) but it is not a latency
 *    either: nothing answers in exactly no time. It is dropped from a
 *    percentile's NUMERATOR AND DENOMINATOR alike, so `n` falls and the drop is
 *    visible rather than halving the percentile in silence.
 *
 * Neither is an aggregation GATE — `isAggregatableRun` remains the only one.
 * ------------------------------------------------------------------------ */

/** The reason code a refused, impossible interval is stored under. */
export const CLOCK_INVERSION = 'clock-inversion';

/** True when an interval says the answer began before the speech that caused it. */
export function isClockInversion(intervalMs: number | null | undefined): boolean {
  return typeof intervalMs === 'number' && intervalMs < 0;
}

/** True when an interval may enter a percentile. Non-positive is not a latency. */
export function isMeasuredLatencyMs(intervalMs: number | null | undefined): intervalMs is number {
  return typeof intervalMs === 'number' && intervalMs > 0;
}

/**
 * Live's cascade spans — the four the client can actually observe, plus the
 * headline they lead to.
 *
 * ROUND 2 — `tts_first_byte` IS a boundary: the server stamps it, Replay
 * already renders it, and it is the ONLY mark from which cascade's
 * time-to-first-audio — the quantity commensurable with Arm A's — can be
 * recovered. `deliver` (the tail of synthesis) stays visible as its own row
 * because it is real information; it is simply not the headline.
 */
export interface LiveCascadeIntervals {
  /** stt_final - vad_fired — detected end of speech -> transcript */
  transcribe: number | null;
  /** mt_first_token - stt_final — transcript -> translated text */
  translate: number | null;
  /** tts_first_byte - mt_first_token — translated text -> audio starts */
  synthesize: number | null;
  /** audio_queued - tts_first_byte — audio starts -> audio complete */
  deliver: number | null;
  /** the headline: first audio - the record's anchor (anchoredLatencyMs) */
  total: number | null;
}

/**
 * Live's realtime span. ONE row, because over WebRTC there is exactly one
 * observable instant on either side: the endpointer's decision and the moment
 * the model's audio begins on the media track. `first_audio_delta` is not read
 * here at ALL — `response.output_audio.delta` does not exist on this transport.
 */
export interface LiveRealtimeIntervals {
  /** audio_queued - server_speech_stopped — detected end of speech -> audio starts */
  model: number | null;
  /** the headline: first audio - the record's anchor (anchoredLatencyMs) */
  total: number | null;
}

export function deriveLiveCascadeIntervals(t: CascadeTimestamps): LiveCascadeIntervals {
  return {
    transcribe: diff(t.stt_final, t.vad_fired),
    translate: diff(t.mt_first_token, t.stt_final),
    synthesize: diff(t.tts_first_byte, t.mt_first_token),
    deliver: diff(t.audio_queued, t.tts_first_byte),
    // R2-5 — THE SAME QUANTITY THE FOOTER REPORTS. The card's total and the
    // ledger's p50 sit under one label, so they must be one number: a record
    // carrying both anchors used to render `audio_queued − vad_fired` on the
    // card and `audio_queued − speech_end` in the footer.
    total: anchoredLatencyMs(t),
  };
}

export function deriveLiveRealtimeIntervals(t: RealtimeTimestamps): LiveRealtimeIntervals {
  return {
    model: diff(t.audio_queued, t.server_speech_stopped),
    total: anchoredLatencyMs(t),
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
  /**
   * TICKET 051 R2-4 — which kind of `speech_end` this record carries.
   * 'corpus' = the manifest's ground truth; 'vad' = an endpointer-derived
   * `speech_end` mark; 'none' = THERE IS NO `speech_end` ON THIS RECORD, which
   * is every Live record: option (c) deliberately never back-derives one. This
   * field is persisted and exported, so 'vad' on a record with no mark is a
   * false claim that outlives the session that wrote it.
   */
  speechEndSource: 'corpus' | 'vad' | 'none';
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
