/**
 * Ticket 008 — One Replay run: Recording -> pacer -> transport -> Run.
 *
 * ============================ API DESIGN (normative) =======================
 * runOnce({ recordingId, config, deps, signal? }) -> RunOnceResult
 *
 * - The recording's audio is fetched ONCE and paced through the ticket-007
 *   pacer: the transport receives 480-sample frames on a 20 ms schedule.
 * - `armTag` is DERIVED via deriveArmTag(config); a caller-supplied tag on
 *   the config is ignored (PRD §6).
 * - `origin` is always 'manual' — only the batch runner (ticket 009) produces
 *   'sweep'.
 * - Replay context is pinned to zero, both architectures. There is
 *   deliberately no context-policy argument.
 * - `speechEndMs` comes from the RECORDING, never re-derived from the
 *   waveform, so every Run of a Recording shares one t0.
 * - NOTHING AUTOPLAYS (PRD §7): the run buffers its output audio and reports
 *   it ready. `timings.audio_queued` is stamped when the first sample is
 *   decoded and queued — playback is the caller's business and never moves it.
 *   TICKET 040: Arm A's audio rides the WebRTC MEDIA TRACK and never reaches
 *   the data channel, so no sample is ever decoded. There the transport SENDS
 *   an `audio_queued` mark and the run falls back to it. A decoded sample
 *   always WINS over a volunteered mark, so cascade is unchanged; with
 *   neither, the value stays null.
 * - A run that loses a stage is saved with status 'failed' plus the failing
 *   stage, is still POSTed, and runOnce RESOLVES rather than throwing.
 *
 * WHAT IDENTIFIES A RUN LIVES ONLY IN THE Run RECORD. The transport is handed
 * nothing but its ordinary TransportConfig — no run id, no arm tag. The wire
 * protocol is a shared contract with the server (and with Live), and widening
 * it so a replay could label itself would make the two paths incomparable.
 *
 * A CANCELLED RUN IS NOT POSTED AT ALL. It has no speech-end-to-audio
 * measurement and only partial transcripts; storing it would put a row in the
 * per-Recording listing that looks like a failure the pipeline caused, when in
 * fact the operator simply stopped watching.
 *
 * TIMING MARKS PASS THROUGH VERBATIM, BY EVENT NAME — with exactly one
 * exception. `speech_end` is taken from the Recording (t0 + speechEndMs) and a
 * transport-sent `speech_end` is DISCARDED. That single anchor is what makes
 * every Run of one Recording comparable: if endpointing drifted per run, the
 * end-to-end number (audio_queued - speech_end) would be measured from a
 * different zero each time and the arm comparison would be meaningless.
 *
 * ------------------- TICKET 031: THE MEASURED ATOM IS THE UTTERANCE --------
 * A PRD §9 corpus Recording is a ≤45 s take holding ~4 utterances of
 * deliberately DIFFERENT categories, so one Recording is not one utterance. A
 * Run is therefore the CONTAINER for the `RunUtterance[]` it produced, and the
 * runner buckets by the `utt` index every transport event already carries
 * (TimingMark.utt, SourceTextEvent.utt, TargetTextEvent.utt, onAudio(pcm, utt),
 * UtteranceCompletion.utt) rather than flattening it away. Manifest `index` is
 * 1-based, transport `utt` is 0-based: `index === utt + 1`.
 *
 * - ORDER COMES FROM THE MANIFEST INDEX, never from array position: the
 *   manifest is sorted by `index` and the records are emitted in that order.
 * - EACH UTTERANCE'S `speech_end` IS `t0 + manifest[i].trueSpeechEndMs` — from
 *   the CORPUS MANIFEST (PRD §8, "corpus-derived true speech end"), never from
 *   the Recording-level `speechEndMs` and never from VAD. A transport-sent
 *   `speech_end` stays discarded per utterance exactly as it is run-wide.
 * - `audio_queued` IS PER UTTERANCE: the clock at the FIRST `onAudio` carrying
 *   that `utt`, else (040) that utterance's own transport-sent `audio_queued`
 *   mark, and `null` when it produced no output audio by either path. Only
 *   that last case is `status: 'failed'` with `errors: ['no output audio']`,
 *   and it does NOT fail the Run — one silent utterance is a datum, not a void
 *   run. The status keys on the RESOLVED value, never on the PCM alone, or a
 *   track-carried utterance would read as failed while the Run reported its
 *   latency.
 * - COST IS SPLIT BY MANIFEST SPAN (`cost_i = costPerMinUsd * span_i / 60_000`,
 *   the last utterance absorbing the clip tail) so the splits sum back to the
 *   Run cost EXACTLY and nothing is invented or lost in the attribution.
 * - SEGMENTATION THAT DISAGREES WITH THE MANIFEST IS A RUN-LEVEL FAILURE, in
 *   either direction: the Run is saved `status: 'failed'` naming
 *   `segmentation: expected N utterances, observed M`, and `utterances` is left
 *   UNDEFINED. Partial attribution would be worse than none — a run whose
 *   segmentation disagrees is not evidence, and half-attributed numbers would
 *   read downstream as if they were.
 *
 * TWO DEADLINES GOVERN A MANIFEST-BACKED RUN, AND ONLY A MANIFEST-BACKED ONE.
 * SEGMENTATION_SETTLE_MS is armed by the Nth (last expected) completion and
 * catches the "too many" direction: without it the run would stop the transport
 * the instant the Nth completion landed and the (N+1)th — the only evidence of
 * an extra split — would never be delivered. SEGMENTATION_IDLE_MS is armed ONCE,
 * WHEN PACING COMPLETES, and catches "too few": a VAD that MERGED two utterances
 * simply delivers N-1 completions and goes quiet, so the settle window never
 * arms and the run would otherwise never resolve. Arming it at pacing end rather
 * than at run start is what keeps it from truncating the clip, and 5 s of
 * post-clip patience is what keeps it from killing a slow-but-valid final
 * utterance. Both are disarmed on EVERY exit — completion, lost stage,
 * cancellation — so no run leaves a timer pending behind it.
 *
 * THE RUN-LEVEL `timings` / `transcripts` / `cost` KEEP TODAY'S SEMANTICS
 * VERBATIM (flat last-mark-wins, last final transcripts, first-audio-overall,
 * `speech_end = t0 + recording.speechEndMs`, whole-clip cost). 031 is purely
 * ADDITIVE: nothing downstream reads `utterances` until ticket 032, so no
 * existing aggregate may move underneath it in the meantime.
 *
 * A MANIFEST-LESS RUN IS BYTE-FOR-BYTE UNCHANGED: it ends at its first
 * utterance boundary, arms neither timer, and carries no `utterances` key.
 *
 * ------------------- TICKET 033: THE CORPUS VERSION IS COPIED HERE ---------
 * `annotations.corpusVersion` is copied from the Recording being replayed, at
 * the moment of the run. It happens HERE, where the Recording is in hand, and
 * NOT in the batch runner's stamping wrapper the way `repIndex` (028) does,
 * because a MANUAL run never passes through that wrapper and its provenance is
 * displayed too. The wrapper spreads `run.annotations` before stamping
 * `repIndex`, so the two ride the same envelope without clobbering each other.
 *
 * COPIED, NEVER DEFAULTED. A Recording that declares no version yields a Run
 * with no `corpusVersion` key at all: the ledger is append-only, so inventing a
 * version here would write a claim the corpus never made and it could never be
 * retracted.
 * ==========================================================================
 */

import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL, deriveArmTag, type ArmTag, type RunConfig } from '../../core/arms';
import type { CorpusUtterance } from '../../core/corpus';
import { readWav } from '../../harness/wav';
import type { InterpreterTransport, TransportConfig } from '../transport/types';
import type { Recording, Run, RunUtterance } from '../state/ledger';
import { ApiError } from './recordingsClient';
import { createPacer, type Pacer, type PacerDeps } from './pacer';
import type { RecordingsClient, RunsClient } from './recordingsClient';

/**
 * TICKET 031 — the settle window a MANIFEST-CARRYING run waits after the last
 * EXPECTED `utterance.complete` before it declares itself over.
 *
 * It exists so that a provider VAD which split the clip into MORE utterances
 * than the manifest describes is CAUGHT rather than silently truncated: without
 * it the run would stop the transport the instant the Nth completion landed and
 * the (N+1)th — the evidence that the segmentation disagrees — would never be
 * delivered. A run whose segmentation disagrees with the manifest is not
 * evidence, so paying this window once per corpus run is the cheap side of the
 * trade.
 *
 * It applies ONLY when the Recording carries a manifest; a mic run still ends
 * at its first utterance boundary exactly as before.
 */
export const SEGMENTATION_SETTLE_MS = 250;

/**
 * TICKET 031 (orchestrator decision) — how long a MANIFEST-CARRYING run waits,
 * AFTER PACING HAS COMPLETED, for the completions it is still owed.
 *
 * The settle window above catches the "too many" direction. This one catches
 * "too few": if a provider's VAD MERGED two utterances, only N-1 completions
 * ever arrive, the settle window never arms, and the run would otherwise never
 * resolve. A merge is precisely the segmentation mismatch this ticket exists to
 * catch, so it must surface as the SAME named run-level failure and never as a
 * hang — one merged clip must not stall an overnight sweep.
 *
 * The deadline is armed ONCE, when pacing completes, and is a hard cap rather
 * than an inter-event idle reset: "wait at most this long for the rest".
 *
 * 5 s is 20x the settle window and comfortably longer than any answer a healthy
 * pipeline still owes once the clip has finished playing, so it never truncates
 * a slow-but-valid final utterance; and it is 24x shorter than the batch
 * runner's 120 s per-run patience (browserDeps RUN_TIMEOUT_MS), so a merged
 * clip fails with a NAMED reason long before the sweep's blunt abort fires.
 *
 * It applies ONLY when the Recording carries a manifest; a manifest-less run's
 * termination is byte-for-byte unchanged, hang included.
 */
export const SEGMENTATION_IDLE_MS = 5_000;

export interface RunOnceConfig extends RunConfig {
  /** Forwarded to the transport config. */
  languagePair?: string;
  direction?: string;
  targetLanguage?: string;
  /**
   * IGNORED. Accepted only so a caller passing a whole run-shaped object does
   * not have to strip it; the produced Run always carries deriveArmTag(config).
   */
  armTag?: ArmTag;
}

export interface RunnerDeps {
  recordings: RecordingsClient;
  runs: RunsClient;
  /** Builds the transport for this configuration (realtime model included). */
  createTransport: (config: RunOnceConfig) => InterpreterTransport;
  /** Epoch-ms clock. */
  now: () => number;
  /** Run id minter. */
  newId: () => string;
  /** Optional clock/scheduler seams handed to the pacer. */
  pacerDeps?: Partial<PacerDeps>;
}

export interface RunOnceOptions {
  recordingId: string;
  config: RunOnceConfig;
  deps: RunnerDeps;
  /** Cancels the run: pacing stops promptly and no complete Run is POSTed. */
  signal?: AbortSignal;
}

export interface RunOnceResult {
  /** The persisted Run record (the value POSTed to /api/runs). */
  run: Run;
  /** Buffered TTS output, concatenated in arrival order. NEVER auto-played. */
  outputAudio: Int16Array;
  /** True once the output audio is buffered and playable on demand. */
  audioReady: boolean;
  /** Epoch ms at which frame 0 was paced — this run's clock anchor. */
  t0: number;
  /** Offset into the clip where speech ends, copied from the Recording. */
  speechEndMs: number;
  /** True when the run was cancelled in flight. */
  cancelled: boolean;
}

/** Concatenates the buffered TTS chunks in arrival order. */
function concatPcm(chunks: Int16Array[]): Int16Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Decodes the fetched WAV. A clip whose bytes will not decode is unplayable in
 * exactly the same way as one whose bytes are missing, so it gets the same
 * code — the caller has one condition to handle, not two.
 */
function decodeClip(bytes: Uint8Array): Int16Array {
  try {
    return readWav(bytes).samples;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ApiError('recording-audio-missing', 422, `recording audio is unplayable: ${detail}`);
  }
}

/**
 * The configuration handed to the transport factory. The realtime model is
 * made EXPLICIT here: the transport's own default is the cheap development
 * model (PRD §5, §14), so a run that let the default stand would derive
 * 'ad-hoc' and Arm A would never appear in the ledger.
 */
function resolveConfig(config: RunOnceConfig): RunOnceConfig {
  if (config.architecture !== 'realtime') return config;
  return { ...config, realtimeModel: config.realtimeModel ?? REALTIME_MODEL };
}

/** The model ids the ledger reads back off the Run (see runArmTag). */
function modelSnapshotsFor(config: RunOnceConfig): Record<string, string> {
  if (config.architecture === 'realtime') {
    return { realtime: config.realtimeModel ?? REALTIME_MODEL };
  }
  return { ...(config.providers ?? DEFAULT_CASCADE_TRIPLE) };
}

/**
 * TICKET 031 — everything the run observed, keyed by transport `utt`.
 *
 * One map per fact rather than one record per utterance: the transport is free
 * to interleave utterances, and an utterance that produced NOTHING but a
 * completion must still be representable (it becomes a 'failed' record, not a
 * missing one), so nothing here is allocated on first sight of an utterance.
 */
interface UtteranceBuckets {
  timings: Map<number, Record<string, number | null>>;
  /** Clock at the FIRST output sample of that utterance. Absent => none. */
  audioAt: Map<number, number>;
  source: Map<number, string>;
  targetFinal: Map<number, string>;
  targetDelta: Map<number, string>;
}

function emptyBuckets(): UtteranceBuckets {
  return {
    timings: new Map(),
    audioAt: new Map(),
    source: new Map(),
    targetFinal: new Map(),
    targetDelta: new Map(),
  };
}

/**
 * TICKET 031 — turns the manifest plus what the transport delivered into the
 * per-utterance records, IN MANIFEST INDEX ORDER.
 *
 * `manifest` arrives sorted by `index`; the transport bucket for entry i is
 * `index - 1`, since manifest indices are 1-based and contiguous (enforced by
 * validateManifest) while transport `utt` is 0-based.
 *
 * The cost split walks the manifest's own speech-end boundaries and gives the
 * clip TAIL to the last utterance, so the parts sum back to the whole-clip Run
 * cost exactly — an attribution that did not would show up in 032 as money
 * appearing or vanishing between the Run and its utterances.
 */
function attributeUtterances(args: {
  manifest: readonly CorpusUtterance[];
  buckets: UtteranceBuckets;
  t0: number;
  durationMs: number;
  costPerMinUsd: number;
}): RunUtterance[] {
  const { manifest, buckets, t0, durationMs, costPerMinUsd } = args;
  const last = manifest.length - 1;

  return manifest.map((entry, i) => {
    const utt = entry.index - 1;

    // Marks pass through verbatim by event name, exactly as at run level...
    const timings: Record<string, number | null> = { ...(buckets.timings.get(utt) ?? {}) };
    // ...except the two the runner owns. The anchor is the MANIFEST's, never
    // the Recording's and never VAD's.
    timings.speech_end = t0 + entry.trueSpeechEndMs;
    // TICKET 040 — a decoded PCM sample still wins; a transport-sent mark is
    // the fallback for the WebRTC media-track case, where the audio never
    // reaches the data channel and only the mark exists.
    const audioAt = buckets.audioAt.get(utt);
    const markedAt = typeof timings.audio_queued === 'number' ? timings.audio_queued : null;
    const audioQueued = audioAt ?? markedAt;
    timings.audio_queued = audioQueued;

    const previousEnd = i === 0 ? 0 : manifest[i - 1]!.trueSpeechEndMs;
    const spanMs = i === last ? durationMs - previousEnd : entry.trueSpeechEndMs - previousEnd;

    const targetDelta = buckets.targetDelta.get(utt) ?? '';
    return {
      utteranceId: entry.id,
      index: entry.index,
      category: entry.category,
      timings,
      transcripts: {
        source: buckets.source.get(utt),
        target: buckets.targetFinal.get(utt) ?? (targetDelta.length > 0 ? targetDelta : undefined),
      },
      cost: costPerMinUsd * (spanMs / 60_000),
      // An utterance with no output audio has no end-to-end number to report,
      // which is a fact about THAT utterance and not about the Run. Keyed on
      // the RESOLVED value (040): a track-carried utterance DID produce audio
      // and must not be marked failed while the run reports its latency.
      status: audioQueued === null ? 'failed' : 'complete',
      errors: audioQueued === null ? ['no output audio'] : [],
    };
  });
}

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const { recordingId, deps, signal } = options;
  const config = resolveConfig(options.config);

  const recording: Recording = await deps.recordings.get(recordingId);
  // Fetched ONCE, and BEFORE any transport exists: an unplayable Recording
  // must not cost a session, a socket, or a provider call.
  const samples = decodeClip(await deps.recordings.getAudio(recordingId));

  // TICKET 031 — the manifest, in INDEX order. Array position carries nothing
  // (see core/corpus.ts); `undefined` here is what makes this a mic-shaped run,
  // and every 031 behaviour below is gated on it.
  const manifest: CorpusUtterance[] | undefined =
    recording.utterances === undefined
      ? undefined
      : [...recording.utterances].sort((a, b) => a.index - b.index);
  const expected = manifest?.length;
  const buckets = emptyBuckets();
  let observed = 0;

  const timings: Record<string, number | null> = {};
  const errors: string[] = [];
  const audioChunks: Int16Array[] = [];
  let firstAudioAt: number | null = null;
  let sourceTranscript: string | undefined;
  let targetTranscript = '';
  let targetFinal: string | undefined;
  let failed = false;

  /**
   * TICKET 031 — the two deadlines of a manifest-backed run (see the header).
   * `disarm` is called on EVERY exit, so neither can outlive the run.
   */
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    if (idleTimer !== null) clearTimeout(idleTimer);
    settleTimer = null;
    idleTimer = null;
  };

  /** Resolves when the utterance completes, or when the run loses a stage. */
  let settle: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const finish = (): void => {
    disarm();
    const resolve = settle;
    settle = null;
    resolve?.();
  };

  const transport = deps.createTransport(config);

  /** Set once pacing begins; a lost stage cancels it from the handler. */
  let pacer: Pacer | null = null;

  const fail = (message: string, stage?: string): void => {
    failed = true;
    errors.push(stage === undefined ? message : `${stage}: ${message}`);
    // The rest of the clip has nowhere to go.
    pacer?.cancel();
    finish();
  };

  transport.setHandlers({
    onSourceText: (e) => {
      // The final transcript wins; a partial is the best answer so far.
      if (e.kind === 'final' || sourceTranscript === undefined) sourceTranscript = e.text;
      // The same rule, applied to that utterance's own bucket.
      if (e.kind === 'final' || !buckets.source.has(e.utt)) buckets.source.set(e.utt, e.text);
    },
    onTargetText: (e) => {
      if (e.kind === 'final') targetFinal = e.text;
      else targetTranscript += e.text;
      if (e.kind === 'final') buckets.targetFinal.set(e.utt, e.text);
      else buckets.targetDelta.set(e.utt, (buckets.targetDelta.get(e.utt) ?? '') + e.text);
    },
    onAudio: (pcm, utt) => {
      // audio_queued: the instant the first sample IS decoded and queued —
      // i.e. the instant it would begin sounding. Nothing is played.
      if (firstAudioAt === null) firstAudioAt = deps.now();
      // ...and the same instant PER UTTERANCE: utterance 2 must never report
      // utterance 1's first audio.
      if (!buckets.audioAt.has(utt)) buckets.audioAt.set(utt, deps.now());
      audioChunks.push(pcm);
    },
    onTiming: (mark) => {
      // The one discarded mark: speech_end is the Recording's, always — and
      // the manifest's, per utterance. Discarded in both places.
      if (mark.event === 'speech_end') return;
      timings[mark.event] = mark.t;
      let bucket = buckets.timings.get(mark.utt);
      if (bucket === undefined) {
        bucket = {};
        buckets.timings.set(mark.utt, bucket);
      }
      bucket[mark.event] = mark.t;
    },
    onUtteranceComplete: () => {
      observed += 1;
      // Manifest-less: over at the first boundary, exactly as it always was.
      if (expected === undefined) {
        finish();
        return;
      }
      // Manifest-backed: the run is not over at the Nth completion but
      // SEGMENTATION_SETTLE_MS after it, so an (N+1)th split still lands and
      // can be reported as the mismatch it is.
      if (observed >= expected && settleTimer === null) {
        settleTimer = setTimeout(() => {
          settleTimer = null;
          finish();
        }, SEGMENTATION_SETTLE_MS);
      }
    },
    onError: (e) => {
      fail(e.message, e.stage);
    },
    onConnectionState: (state) => {
      // 'disconnected' means the retries are exhausted (see transport/types).
      if (state === 'disconnected' && !failed) fail('transport disconnected');
    },
  });

  const transportConfig: TransportConfig = {
    languagePair: config.languagePair ?? '',
    direction: config.direction ?? '',
    targetLanguage: config.targetLanguage ?? '',
    providers: config.providers,
  };
  await transport.start(transportConfig);

  // The clock anchor: epoch ms of frame 0. Every timing the run reports is
  // meaningful only relative to this.
  const t0 = deps.now();
  pacer = createPacer({
    samples,
    onFrame: (frame) => {
      transport.sendAudio(frame);
    },
    signal,
    deps: deps.pacerDeps,
  });

  // A transport that failed during start() is never fed.
  if (failed) pacer.cancel();
  await pacer.start();

  const cancelled = signal?.aborted ?? false;
  // TICKET 031 — the idle deadline is armed HERE, once the clip has finished
  // playing, so it caps the WAIT for outstanding completions and can never
  // truncate pacing. Manifest-backed runs only: a mic run's termination is
  // unchanged, hang included.
  if (manifest !== undefined && !cancelled && !failed) {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      finish();
    }, SEGMENTATION_IDLE_MS);
  }
  // Pacing is done; the answer may still be in flight. The run is over only
  // once the utterance completes too — a cancelled or failed run waits for
  // nothing.
  if (!cancelled && !failed) await finished;
  // Belt and braces for the paths that never awaited `finished` at all.
  disarm();

  transport.stop();

  const outputAudio = concatPcm(audioChunks);
  timings.speech_end = t0 + recording.speechEndMs;
  // TICKET 040 — a decoded PCM sample wins, then a transport-sent mark (the
  // WebRTC media-track case, where nothing is ever decoded), then null. Before
  // this the mark was overwritten with a null firstAudioAt, so every Replay
  // Arm A run counted toward n and cost while contributing no latency sample.
  const markedAudioQueued = typeof timings.audio_queued === 'number' ? timings.audio_queued : null;
  timings.audio_queued = firstAudioAt ?? markedAudioQueued;

  if (cancelled) errors.push('run cancelled');

  // TICKET 031 — segmentation is checked in BOTH directions, and a disagreement
  // is a run-level failure with NO partial attribution: a run whose segmentation
  // disagrees with the manifest is not evidence. A cancelled run is exempt —
  // its completions were cut short by the operator, not by the pipeline.
  const mismatched = !cancelled && expected !== undefined && observed !== expected;
  if (mismatched) {
    errors.push(`segmentation: expected ${expected} utterances, observed ${observed}`);
  }

  const utterances =
    manifest === undefined || mismatched || cancelled
      ? undefined
      : attributeUtterances({
          manifest,
          buckets,
          t0,
          durationMs: recording.durationMs,
          costPerMinUsd: transport.costPerMinUsd,
        });

  const run: Run = {
    id: deps.newId(),
    recordingId: recording.id,
    architecture: config.architecture,
    providerTriple: config.providers,
    modelSnapshots: modelSnapshotsFor(config),
    // DERIVED, never declared — a caller-supplied config.armTag is ignored.
    armTag: deriveArmTag(config),
    // Only the batch runner (ticket 009) produces 'sweep'.
    origin: 'manual',
    status: cancelled || failed || mismatched ? 'failed' : 'complete',
    timings,
    transcripts: {
      source: sourceTranscript,
      target: targetFinal ?? (targetTranscript.length > 0 ? targetTranscript : undefined),
    },
    cost: transport.costPerMinUsd * (recording.durationMs / 60_000),
    utterances,
    errors,
    createdAt: deps.now(),
  };

  // TICKET 033 — the corpus version travels with the measurement. Only when the
  // Recording declares one: an absent version stays absent rather than becoming
  // a default nobody can ever take back out of an append-only ledger.
  if (recording.corpusVersion !== undefined) {
    run.annotations = { ...run.annotations, corpusVersion: recording.corpusVersion };
  }

  // A failure is real information and is stored like any other run (PRD §12).
  // A cancellation is not: see the header.
  if (!cancelled) await deps.runs.create(run);

  return {
    run,
    outputAudio,
    audioReady: outputAudio.length > 0,
    t0,
    speechEndMs: recording.speechEndMs,
    cancelled,
  };
}
