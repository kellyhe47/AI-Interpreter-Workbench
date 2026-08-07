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
 * ==========================================================================
 */

import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL, deriveArmTag, type ArmTag, type RunConfig } from '../../core/arms';
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

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const { recordingId, deps, signal } = options;
  const config = resolveConfig(options.config);

  const recording: Recording = await deps.recordings.get(recordingId);
  // Fetched ONCE, and BEFORE any transport exists: an unplayable Recording
  // must not cost a session, a socket, or a provider call.
  const samples = decodeClip(await deps.recordings.getAudio(recordingId));

  const manifest =
    recording.utterances === undefined
      ? undefined
      : [...recording.utterances].sort((a, b) => a.index - b.index);
  const expected = manifest?.length;
  const uttTimings = new Map<number, Record<string, number | null>>();
  const uttAudioAt = new Map<number, number>();
  const uttSource = new Map<number, string>();
  const uttTargetFinal = new Map<number, string>();
  const uttTargetDelta = new Map<number, string>();
  let observed = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const timings: Record<string, number | null> = {};
  const errors: string[] = [];
  const audioChunks: Int16Array[] = [];
  let firstAudioAt: number | null = null;
  let sourceTranscript: string | undefined;
  let targetTranscript = '';
  let targetFinal: string | undefined;
  let failed = false;

  /** Resolves when the utterance completes, or when the run loses a stage. */
  let settle: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const finish = (): void => {
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
    disarm();
    finish();
  };

  transport.setHandlers({
    onSourceText: (e) => {
      // The final transcript wins; a partial is the best answer so far.
      if (e.kind === 'final' || sourceTranscript === undefined) sourceTranscript = e.text;
      if (e.kind === 'final' || !uttSource.has(e.utt)) uttSource.set(e.utt, e.text);
    },
    onTargetText: (e) => {
      if (e.kind === 'final') targetFinal = e.text;
      else targetTranscript += e.text;
      if (e.kind === 'final') uttTargetFinal.set(e.utt, e.text);
      else uttTargetDelta.set(e.utt, (uttTargetDelta.get(e.utt) ?? '') + e.text);
    },
    onAudio: (pcm, utt) => {
      // audio_queued: the instant the first sample IS decoded and queued —
      // i.e. the instant it would begin sounding. Nothing is played.
      if (firstAudioAt === null) firstAudioAt = deps.now();
      if (!uttAudioAt.has(utt)) uttAudioAt.set(utt, deps.now());
      audioChunks.push(pcm);
    },
    onTiming: (mark) => {
      // The one discarded mark: speech_end is the Recording's, always.
      if (mark.event === 'speech_end') return;
      timings[mark.event] = mark.t;
      let bucket = uttTimings.get(mark.utt);
      if (!bucket) {
        bucket = {};
        uttTimings.set(mark.utt, bucket);
      }
      bucket[mark.event] = mark.t;
    },
    onUtteranceComplete: () => {
      observed += 1;
      if (expected === undefined) {
        finish();
        return;
      }
      if (observed >= expected && settleTimer === null) {
        settleTimer = setTimeout(() => {
          settleTimer = null;
          disarm();
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
  // The idle deadline is armed HERE — once the clip has finished playing — so
  // it governs the WAIT for outstanding completions and never truncates pacing.
  if (manifest !== undefined && !cancelled && !failed) {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      disarm();
      finish();
    }, SEGMENTATION_IDLE_MS);
  }
  // Pacing is done; the answer may still be in flight. The run is over only
  // once the utterance completes too — a cancelled or failed run waits for
  // nothing.
  if (!cancelled && !failed) await finished;

  disarm();
  transport.stop();

  const outputAudio = concatPcm(audioChunks);
  timings.speech_end = t0 + recording.speechEndMs;
  timings.audio_queued = firstAudioAt;

  if (cancelled) errors.push('run cancelled');

  const mismatched = expected !== undefined && observed !== expected;
  if (mismatched) {
    errors.push(`segmentation: expected ${expected} utterances, observed ${observed}`);
  }

  let utterances: RunUtterance[] | undefined;
  if (manifest !== undefined && !mismatched) {
    utterances = manifest.map((entry, i) => {
      const bucket = { ...(uttTimings.get(i) ?? {}) };
      bucket.speech_end = t0 + entry.trueSpeechEndMs;
      const audioAt = uttAudioAt.get(i);
      bucket.audio_queued = audioAt ?? null;
      const previousEnd = i === 0 ? 0 : manifest[i - 1]!.trueSpeechEndMs;
      const spanMs =
        i === manifest.length - 1
          ? recording.durationMs - previousEnd
          : entry.trueSpeechEndMs - previousEnd;
      const targetDelta = uttTargetDelta.get(i) ?? '';
      return {
        utteranceId: entry.id,
        index: entry.index,
        category: entry.category,
        timings: bucket,
        transcripts: {
          source: uttSource.get(i),
          target: uttTargetFinal.get(i) ?? (targetDelta.length > 0 ? targetDelta : undefined),
        },
        cost: transport.costPerMinUsd * (spanMs / 60_000),
        status: audioAt === undefined ? 'failed' : 'complete',
        errors: audioAt === undefined ? ['no output audio'] : [],
      };
    });
  }

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
