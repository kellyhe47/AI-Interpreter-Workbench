/**
 * Ticket 035 — split a recorded take into utterances. PURE: no DOM, no node
 * globals, no I/O, deterministic for a given Int16Array.
 *
 * STUB — types and constants only; segment.test.ts pins every behavior.
 *
 * ============================ API DESIGN (normative) =======================
 * segmentTake(samples, opts?) -> SegmentedUtterance[]
 *
 * Analysis runs on non-overlapping SEGMENT_FRAME_MS frames of 24 kHz mono
 * PCM16. A frame is "loud" when rms(frame) >= floor. Consecutive loud frames
 * form a run; two runs separated by LESS than `silenceMs` of quiet are the
 * same utterance (a mid-sentence pause is not a boundary). Runs shorter than
 * `minUtteranceMs` are dropped as slivers. Leading and trailing quiet produce
 * no utterance, and a wholly quiet take yields [].
 *
 * `trueSpeechEndMs` is the position of the LAST SAMPLE above the floor in that
 * utterance, measured from the START OF THE CLIP — PRD §8's true speech end,
 * computed once from the waveform and later frozen into the ticket-030
 * manifest, never a per-arm VAD guess.
 *
 * The 500 ms default matches the pinned endpointing control every arm uses
 * (`silence_duration_ms: 500`, PRD §8). A segmenter that disagreed with the
 * measured VAD would invite boundary disputes later, so the two are kept equal
 * deliberately.
 * ==========================================================================
 */

/** Analysis frame: 20 ms = 480 samples at 24 kHz, the capture frame size. */
export const SEGMENT_FRAME_MS = 20;

export interface SegmentOptions {
  /** Quiet needed to end an utterance. */
  silenceMs?: number;
  /** RMS threshold (0..1) below which a frame counts as silence. */
  floor?: number;
  /** Runs shorter than this are discarded. */
  minUtteranceMs?: number;
}

export const DEFAULT_SEGMENT_OPTIONS: Required<SegmentOptions> = {
  silenceMs: 500,
  floor: 0.01,
  minUtteranceMs: 200,
};

export interface SegmentedUtterance {
  /** 1-based position within the clip; matches CorpusUtterance.index. */
  index: number;
  startMs: number;
  /** Ms from the start of the clip; matches CorpusUtterance.trueSpeechEndMs. */
  trueSpeechEndMs: number;
}

export function segmentTake(
  _samples: Int16Array,
  _opts?: SegmentOptions,
): SegmentedUtterance[] {
  throw new Error('segmentTake is not implemented (ticket 035)');
}
