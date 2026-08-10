/**
 * Ticket 035 — split a recorded take into utterances. PURE: no DOM, no node
 * globals, no I/O, deterministic for a given Int16Array.
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
 * The `silenceMs` default IS the pinned endpointing control every arm uses
 * (`ENDPOINTING_MS`, PRD §8) — imported, not re-typed, so the segmenter cannot
 * drift away from the measured VAD and invite boundary disputes later.
 * `index` is renumbered 1..N AFTER slivers are dropped, so the output always
 * satisfies ticket 030's validateManifest contiguity rule directly.
 * ==========================================================================
 */

import { ENDPOINTING_MS } from '../../core/protocol';
import { rms } from '../audio/pcm';

/** Analysis frame: 20 ms = 480 samples at 24 kHz, the capture frame size. */
export const SEGMENT_FRAME_MS = 20;

/** Segmentation is defined on 24 kHz mono PCM16 only; the rate is not an option. */
const SEGMENT_RATE = 24_000;

/** 480 samples per analysis frame. */
const FRAME_SAMPLES = (SEGMENT_FRAME_MS * SEGMENT_RATE) / 1000;

export interface SegmentOptions {
  /** Quiet needed to end an utterance. */
  silenceMs?: number;
  /** RMS threshold (0..1) below which a frame counts as silence. */
  floor?: number;
  /** Runs shorter than this are discarded. */
  minUtteranceMs?: number;
}

export const DEFAULT_SEGMENT_OPTIONS: Required<SegmentOptions> = {
  silenceMs: ENDPOINTING_MS,
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

/** Half-open run of loud analysis frames: [startFrame, endFrame). */
interface FrameRun {
  startFrame: number;
  endFrame: number;
}

function samplesToMs(sampleIndex: number): number {
  return Math.round((sampleIndex / SEGMENT_RATE) * 1000);
}

export function segmentTake(
  samples: Int16Array,
  opts?: SegmentOptions,
): SegmentedUtterance[] {
  const { silenceMs, floor, minUtteranceMs } = { ...DEFAULT_SEGMENT_OPTIONS, ...opts };

  // A trailing partial frame (< 20 ms) is not analysed: one frame is the
  // stated resolution of every boundary this module reports.
  const frameCount = Math.floor(samples.length / FRAME_SAMPLES);

  // 1. Loud runs of contiguous frames.
  const runs: FrameRun[] = [];
  let open: FrameRun | null = null;
  for (let f = 0; f < frameCount; f++) {
    const start = f * FRAME_SAMPLES;
    const loud = rms(samples.subarray(start, start + FRAME_SAMPLES)) >= floor;
    if (loud) {
      if (open) open.endFrame = f + 1;
      else open = { startFrame: f, endFrame: f + 1 };
    } else if (open) {
      runs.push(open);
      open = null;
    }
  }
  if (open) runs.push(open);

  // 2. Merge across gaps shorter than silenceMs — a mid-sentence pause is not
  //    an utterance boundary.
  const merged: FrameRun[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous && (run.startFrame - previous.endFrame) * SEGMENT_FRAME_MS < silenceMs) {
      previous.endFrame = run.endFrame;
    } else {
      merged.push({ ...run });
    }
  }

  // 3. Drop slivers, then renumber 1..N so the indices stay contiguous.
  const kept = merged.filter(
    (run) => (run.endFrame - run.startFrame) * SEGMENT_FRAME_MS >= minUtteranceMs,
  );

  return kept.map((run, i) => {
    const startSample = run.startFrame * FRAME_SAMPLES;
    const endSample = Math.min(run.endFrame * FRAME_SAMPLES, samples.length);
    const startMs = run.startFrame * SEGMENT_FRAME_MS;

    // Sample-accurate, not frame-accurate: the true speech end PRD §8 wants is
    // the LAST sample above the floor, not the end of the frame holding it.
    let lastLoud = -1;
    for (let i2 = endSample - 1; i2 >= startSample; i2--) {
      if (Math.abs(samples[i2]!) / 32768 > floor) {
        lastLoud = i2;
        break;
      }
    }
    const endMs = lastLoud < 0 ? samplesToMs(endSample) : samplesToMs(lastLoud);

    return {
      index: i + 1,
      startMs,
      // Strictly after startMs, which validateManifest's monotonicity needs.
      trueSpeechEndMs: Math.max(endMs, startMs + 1),
    };
  });
}
