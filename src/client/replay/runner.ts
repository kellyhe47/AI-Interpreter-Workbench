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
 * - TICKET 045: the buffered output audio is UPLOADED to the run's own audio
 *   endpoint FIRST, and the Run is POSTed SECOND carrying the
 *   `outputAudioPath` the upload REPORTED. The ledger is append-only with no
 *   PATCH, so the reverse order could never correct a Run that promised audio a
 *   failed upload never wrote. A failed run uploads its partial audio (PRD §12,
 *   it is diagnostic); a cancelled run and a run that produced no samples
 *   upload nothing; an upload failure does NOT fail the run — it rides the
 *   run's own `errors` and leaves `outputAudioPath` unset.
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
 *
 * ------------------- TICKET 048: WHICH WAITS ARE BOUNDED, AND WHY ----------
 * `runOnce` bounds the three waits in the TAIL of a run — after the last point
 * at which a caller could still be watching a progress bar and after the
 * measurement is (or has failed to become) real:
 *
 *   `finished`          RUN_COMPLETION_TIMEOUT_MS   FATAL — see the constant
 *   `transport.stop()`  TRANSPORT_CLOSE_TIMEOUT_MS  costs a leaked context (046)
 *   `runs.uploadAudio`  AUDIO_UPLOAD_TIMEOUT_MS     costs the artifact (045)
 *   `runs.create`       RUN_POST_TIMEOUT_MS         costs the ROW (048 R3-1)
 *
 * A RUN ALWAYS RETURNS BEFORE THE SWEEP ABANDONS IT, so a retry can never be
 * started beside an attempt whose POST is still in flight — which is the only
 * way one repetition can reach an append-only ledger as two aggregatable Runs.
 * ROUND 4 (R4-1) corrected what that sum has to include: PACING is the run's
 * DOMINANT cost (MAX_CLIP_MS, up to 45 s at 1x for a §9 take) and round 3 left
 * it out, along with the two unbounded setup awaits — claiming 43 s of slack
 * against an omitted term larger than the slack itself. The reachable worst case
 * is 45 + 77 = 122 s, so browserDeps' patience went to 180 s. There is a guard
 * test on both sums; do not break it.
 *
 * THE INEQUALITY IS THE SECOND LINE OF DEFENCE, NOT THE FIRST. It is a promise
 * about constants that nobody re-derives when one is tuned. The primary defence
 * is structural and lives in `startBatch`: a cell whose attempt already POSTed is
 * never retried while that POST's fate is UNKNOWN, so the duplicate is
 * impossible whatever these numbers say.
 *
 * THE REMAINING AWAITS ARE DELIBERATELY LEFT TO `runTimeoutMs`, not overlooked:
 * `recordings.get` and `recordings.getAudio`. Both are SETUP calls whose failure
 * has no run-level verdict to record — a run that never got its audio has no
 * measurement to keep honest and no Run to write — so an ad-hoc deadline here
 * would buy nothing the sweep's budget does not already buy, and would add
 * another number to keep ordered against it. `transport.start()` is not bounded
 * either, but it IS abort-aware (R3-3), which is what that wait actually needed:
 * the transport already exists by then, so the cost of ignoring an abort there
 * is a live AudioContext pair, not a hang.
 *
 * ROUND 2 made the delegation real in both directions: the budget now RACES the
 * attempt rather than merely aborting a signal, `runOnce` re-reads `signal` after
 * every bounded wait so an abandoned attempt stops writing and gives its
 * transport back, and the batch executor persists a FAILED stub for a rep
 * abandoned before any Run existed so the provenance denominator still counts it.
 *
 * ONE ACCEPTED COST, WRITTEN DOWN RATHER THAN LEFT SILENT (R3-4): an abort that
 * lands while the output-audio upload is in flight leaves `runs/<id>.out.wav`
 * stored for a Run that is then never POSTed. The bytes are orphaned — no ledger
 * row references them, so no figure, no listing and no blind-compare pair can
 * ever reach them. Chasing them would mean a DELETE against an append-only
 * store, which is a worse property than a few unreferenced files in a sweep that
 * was already going wrong.
 *
 * A LATE ABORT IS A CANCELLATION, NOT A TIMEOUT. `cancelled` is re-read at every
 * bounded wait rather than snapshotted once after pacing: an abort raised while
 * the run is parked on `finished` or on its upload means the CALLER stopped
 * waiting, so the run uploads nothing further and POSTs nothing at all. A Run
 * written after that point is a second, aggregatable sample of a repetition the
 * sweep has already retried — silent double-weighting that `derive.ts`'s
 * distinct-repIndex provenance would report as clean.
 * ==========================================================================
 */

import { DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL, deriveArmTag, type ArmTag, type RunConfig } from '../../core/arms';
import type { CorpusUtterance } from '../../core/corpus';
import { readWav, writeWav } from '../../harness/wav';
import { SAMPLE_RATE } from '../../core/protocol';
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

/**
 * TICKET 046 ROUND 3 (R3-1) — how long a run waits for the transport's audio
 * contexts to close before giving up on them.
 *
 * Round 2 made `transport.stop()` awaited, so a run no longer starts the next
 * one while its two AudioContexts are still closing. Awaiting it UNBOUNDED
 * traded that bounded leak for an unbounded stall: nothing races this wait —
 * `startBatch`'s `runTimeoutMs` only calls `controller.abort()`, and `runOnce`
 * reads the abort signal nowhere after pacing — so a wedged context (a device
 * change or removal is the classic cause) whose `close()` never settles freezes
 * the run "running" forever, stops the sweep advancing, stores no Run and
 * reports no error.
 *
 * Two seconds is far longer than a healthy `AudioContext.close()` and far
 * shorter than the 120 s per-run patience above, so a wedged context costs one
 * leaked context and NOT the measurement — which is the trade the fire-and-
 * forget version got backwards in the other direction.
 */
export const TRANSPORT_CLOSE_TIMEOUT_MS = 2_000;

/**
 * TICKET 048 — how long a run waits for the output-audio upload before giving up
 * on the STORE.
 *
 * `runs.uploadAudio` is a bare browser `fetch` with no timeout, so a server that
 * accepts the connection and never answers hangs the run forever — and nothing
 * races it (`startBatch`'s `runTimeoutMs` bounds the ATTEMPT, not this wait).
 * This is the ARTIFACT side-effect, not the measurement: giving up on it must
 * never cost the run's numbers.
 *
 * ROUND 2 (R2-4) — 30 s, NOT 10 s. The output WAV is 24 kHz mono PCM16 (48 kB/s),
 * so a 45 s PRD §9 take is ~2.2 MB; clearing that inside 10 s demands ~1.7 Mbps
 * SUSTAINED, which is free against a localhost dev server and marginal against
 * the planned EC2 deploy. A budget that expires on HEALTHY uploads is worse than
 * no budget, because it fails silently.
 *
 * AND WHAT IT COSTS IS NOT "THE BYTES". A Run with no stored output audio is
 * ineligible for BLIND COMPARE, which is playback-only — so an upload budget
 * tuned for localhost quietly shrinks the pool the pairwise judgements can draw
 * from. That is a PRD §8 deliverable, not a cache. The latency figures survive
 * (which is why this deadline is still not fatal), but the qualitative half of
 * the experiment loses samples it can never get back from an append-only ledger.
 */
export const AUDIO_UPLOAD_TIMEOUT_MS = 30_000;

/**
 * TICKET 048 — how long a run waits on `finished` before declaring the
 * measurement lost.
 *
 * SEGMENTATION_IDLE_MS already caps a manifest-backed run. A MANIFEST-LESS
 * (mic-shaped) run arms neither 031 timer and waits on `finished` forever, so a
 * transport that goes quiet without ever completing its utterance freezes the
 * run. Unlike the upload, this deadline IS fatal: a run that never saw its
 * utterance complete does not know whether it saw the whole answer.
 *
 * Longer than SEGMENTATION_IDLE_MS so a manifest-backed run still fails with its
 * own NAMED segmentation reason, and far shorter than the sweep's 120 s per-run
 * patience (browserDeps RUN_TIMEOUT_MS) so the reason is named before the blunt
 * abort fires.
 */
export const RUN_COMPLETION_TIMEOUT_MS = 30_000;

/**
 * TICKET 048 — the prefix of the line a run carries when it gave up waiting for
 * the utterance completion that never came.
 */
export const RUN_COMPLETION_TIMED_OUT = 'run timed out waiting for utterance completion';

/**
 * TICKET 048 ROUND 3 (R3-1) — how long a run waits for `runs.create` to
 * acknowledge the POST.
 *
 * IT IS WHAT MAKES A SECOND SAMPLE OF ONE REP IMPOSSIBLE, and that is a stronger
 * claim than "the run does not hang". Every other wait in the tail is guarded by
 * re-reading the abort signal, but the POST is the one place that cannot be: the
 * last re-read sits immediately BEFORE `deps.runs.create(run)`, so an abort that
 * lands while the POST is in flight arrives too late to stop it, the sweep
 * retries the attempt it abandoned, and BOTH rows reach an append-only ledger
 * carrying `origin: 'sweep'` and the same `annotations.repIndex`. `derive.ts`
 * counts DISTINCT rep indices, so provenance renders a clean "1 of 1 reps
 * completed" over an `n` pooled from two samples of one repetition. The sweep
 * summary shows nothing wrong.
 *
 * Bounding the POST removes the window rather than policing it: as long as every
 * budget `runOnce` can spend adds up to LESS than the sweep's per-run patience
 * (browserDeps RUN_TIMEOUT_MS), the attempt always RETURNS before the sweep
 * abandons it, so no retry can ever race a live POST. That sum is pinned as a
 * guard beside these constants.
 *
 * A POST that times out costs the ROW, not the measurement — the 045 verdict
 * again: the pipeline did its job and the store did not, so `status` stays
 * `complete` and the reason rides `errors`.
 */
export const RUN_POST_TIMEOUT_MS = 15_000;

/**
 * TICKET 048 ROUND 3 — the prefix of the line a run carries when the ledger
 * never acknowledged its POST.
 */
export const RUN_POST_TIMED_OUT = 'run record post failed: no response within';

/**
 * TICKET 048 ROUND 4 (R4-1) — the longest clip a run can be asked to pace, from
 * PRD §9: a corpus Recording is a ≤45 s take.
 *
 * IT BELONGS IN THE BUDGET ARITHMETIC BECAUSE IT IS THE RUN'S DOMINANT COST.
 * Round 3's guard enumerated the worst case as "park on `finished`, wedge the
 * close, hang the upload, then hang the POST" and summed 77 s against 120 s of
 * sweep patience — omitting pacing entirely. The omitted term is larger than the
 * 43 s of slack the guard was claiming, so at production constants the attempt
 * can still be abandoned mid-POST and its retry writes a SECOND aggregatable Run
 * for the same rep, under provenance that renders a clean "1 of 1".
 */
export const MAX_CLIP_MS = 45_000;

/**
 * TICKET 046 ROUND 3 (R3-7) — the prefix of the line a run carries when the
 * capture path SAW a track and admitted none of it.
 *
 * AC1 is the one criterion vitest cannot prove; the ticket concedes it to an
 * operator smoke test. Since capture hangs off `output_audio_buffer.started`,
 * a gate that never opened stores an artifact byte-identical to a model that
 * never spoke — so without this the smoke test cannot confirm AC1, it can only
 * fail to contradict it.
 *
 * It is a DIAGNOSTIC, NOT A FAILURE. It rides `run.errors` exactly as 045's
 * upload failure does: `status` stays `complete`, the utterances stay attributed
 * and every timing is untouched, because aggregation (exportResults,
 * results/derive) gates on `status === 'complete'` and never on `errors`. A
 * diagnostic that silently disqualified runs from aggregation would be far worse
 * than the blind spot it replaces.
 */
export const CAPTURE_GATE_NEVER_OPENED = 'output audio capture: gate never opened';

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
 * TICKET 048 — what a bounded wait resolves to when the DEADLINE won rather than
 * the wait itself. A sentinel rather than a rejection: `runOnce` resolves even
 * for a lost run, and every deadline here is a verdict the caller has to record,
 * not an exception to unwind through.
 */
const DEADLINE: unique symbol = Symbol('deadline');

/**
 * TICKET 048 — awaits `begin()`, but NEVER LONGER THAN THE BUDGET.
 *
 * The generalised form of 046 R3-1's `closeTransport`, because three ad-hoc races
 * would be the same bug fixed three times and a fourth wait added later would be
 * covered by none of them. `runTimeoutMs` cannot rescue any of these: `startBatch`
 * only calls `controller.abort()`, and `runOnce` reads that signal nowhere after
 * pacing, so every wait in the tail of a run has to bound ITSELF.
 *
 * - A THUNK, not a promise (R4-2): the CALL is inside the caller's guard too, so
 *   a seam that throws synchronously is handled like one that rejects.
 * - THE SHAPE IS WHAT KEEPS AN ABANDONED PROMISE FROM LEAKING. A `fetch` the
 *   deadline gave up on typically fails on its own much later; that is only an
 *   unhandled rejection if nothing is listening. `Promise.race` attaches a
 *   rejection handler to EVERY operand, so passing `pending` in directly is the
 *   guarantee — what would leak is a fulfilment-only bound
 *   (`pending.then(resolve)` beside a timer), which is precisely the shape this
 *   avoids. ROUND 2 (R2-6): the explicit `void pending.catch()` below is
 *   BELT-AND-BRACES against a future refactor away from `race`; it is not what
 *   makes today's version safe, and deleting it changes nothing.
 * - THE TIMER IS CLEARED ON EVERY PATH, rejection included. A race that leaves
 *   its handle armed is a live timer per run and a fake-timer teardown that lies
 *   about what is still pending.
 */
async function withDeadline<T>(
  begin: () => Promise<T>,
  timeoutMs: number,
): Promise<T | typeof DEADLINE> {
  const pending = begin();
  // Belt-and-braces only — the race below already listens for this rejection.
  void pending.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<typeof DEADLINE>((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * TICKET 048 ROUND 2 (R2-1/R2-2) — settles when `pending` settles OR when the
 * caller gives up, whichever comes first.
 *
 * `runOnce` used to read `signal` exactly once, immediately after pacing, and
 * every decision downstream keyed on that SNAPSHOT — so an abort raised later,
 * which is exactly what `startBatch`'s budget raises when it abandons an
 * attempt, was invisible. The abandoned run then held its transport (for Arm A,
 * two AudioContexts) beside the retry's own for the rest of its completion
 * budget, and finished by POSTing a Run the sweep had already written off.
 *
 * Making the abort an OPERAND of the wait — rather than a third gate bolted on
 * after it — is what lets the run honour a late abort at its next await: the
 * caller recomputes `cancelled` once the wait returns, and that single re-read
 * covers the upload skip, the POST gate and the reported `cancelled` alike.
 *
 * ROUND 3 (R3-3) — `transport.start()` goes through here too. It is the WORST
 * wait to leave bare: the transport already EXISTS by then, so an abort during
 * the handshake leaves it live until a handshake that may never land resolves.
 * Four abandoned attempts is four live transports — for Arm A eight
 * AudioContexts — against Chrome's cap of roughly six, which is ticket 046's
 * whole premise. Routing it through here needs no early-return branch: the pacer
 * already takes `signal`, and `cancelled` is re-read straight after it, so the
 * existing teardown path picks the run up.
 *
 * A FAILURE STILL PROPAGATES. Only the ABORT is turned into a resolution here:
 * a `transport.start()` that rejects must still lose the run its stage exactly
 * as it always did, so this is a race with the signal and not a swallow.
 */
function untilSettledOrAborted<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (signal === undefined) return pending;
  if (signal.aborted) {
    // Already given up on: keep a handler so the orphan cannot leak.
    void pending.catch(() => undefined);
    return Promise.resolve(undefined);
  }
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = (): void => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (cause) => {
        signal.removeEventListener('abort', onAbort);
        // A no-op once the abort has already won, and the rejection is HANDLED
        // either way — an abandoned handshake that fails later must not leak.
        reject(cause);
      },
    );
  });
}

/**
 * TICKET 048 ROUND 2 (R2-3) — the Run a caller writes for an execution it
 * ABANDONED before `runOnce` could produce one of its own.
 *
 * `startBatch`'s budget can abandon an attempt arbitrarily early — a
 * `recordings.getAudio` that never answers means the run never reaches a Run at
 * all. Round 1 recorded that as harmless ("there is no Run, so nothing needs
 * excluding"), which is true of the NUMERATOR and wrong about the DENOMINATOR:
 * `derive.ts` builds `intendedReps` from the distinct `annotations.repIndex` over
 * the arm's sweep Runs of ANY status, so a rep that produced no Run is absent
 * from what the sweep claims to have attempted and a sweep that lost rep 2
 * renders "2 of 2 reps completed". That is provenance reporting a lossy sweep as
 * clean — the failure AGENTS.md names verbatim.
 *
 * IT IS EXCLUDED BY THE EXISTING GATE AND NOTHING ELSE. `status: 'failed'` is
 * the whole mechanism; flip it and `isAggregatableRun` changes its mind. The
 * derived arm, the provider triple and the model snapshots are real so the stub
 * lands in the RIGHT arm's denominator — a stub that derived 'ad-hoc' would be
 * invisible in exactly the way this exists to fix.
 */
export function abandonedRunStub(args: {
  id: string;
  recordingId: string;
  config: RunOnceConfig;
  createdAt: number;
  reason: string;
}): Run {
  const config = resolveConfig(args.config);
  return {
    id: args.id,
    recordingId: args.recordingId,
    architecture: config.architecture,
    providerTriple: config.providers,
    modelSnapshots: modelSnapshotsFor(config),
    armTag: deriveArmTag(config),
    // The caller stamps the origin it ran under, exactly as it stamps a real one.
    origin: 'manual',
    status: 'failed',
    timings: {},
    transcripts: {},
    cost: 0,
    errors: [args.reason],
    createdAt: args.createdAt,
  };
}

/**
 * TICKET 045 — stores the run's output audio and reports where it landed.
 *
 * ORDER IS LOAD-BEARING: this runs BEFORE the Run is POSTed. The ledger is
 * append-only with no PATCH, so a Run written first could never be corrected
 * when the upload failed — it would sit in the history claiming audio nobody
 * ever wrote, and the play control (gated on exactly that field) would offer a
 * button that 404s.
 *
 * NOTHING IS UPLOADED FOR A RUN THAT PRODUCED NO SAMPLES. An empty
 * runs/<id>.out.wav would make GET /audio answer 200-with-silence instead of
 * the honest 404 — and that is today's Arm A, whose audio rides the WebRTC
 * media track and never reaches `onAudio` (ticket 046).
 *
 * A FAILED UPLOAD DOES NOT FAIL THE RUN. The measurement is the valuable
 * artifact and it is already in hand; the store losing the bytes is surfaced as
 * one of the run's own `errors` — which ride the same append-only ledger line —
 * and the run claims no path.
 *
 * TICKET 048 — AND IT IS BOUNDED. `runs.uploadAudio` is a bare browser `fetch`
 * with no timeout of its own, so a server that accepts the connection and never
 * answers hangs the run forever. A HUNG upload is a FAILED upload with a slower
 * cause, and it gets 045's verdict verbatim: the run stays `complete`, every
 * timing survives, the Run is POSTed, `outputAudioPath` stays unset, and the
 * reason rides `errors` NAMING the budget so an operator can tell a store that
 * refused from one that went quiet. Any harsher verdict would let a flaky
 * artifact store silently delete good latency samples from the experiment.
 */
async function uploadOutputAudio(args: {
  runs: RunsClient;
  id: string;
  outputAudio: Int16Array;
  skip: boolean;
  errors: string[];
}): Promise<string | undefined> {
  if (args.skip || args.outputAudio.length === 0) return undefined;
  try {
    const uploaded = await withDeadline(
      () => args.runs.uploadAudio(args.id, writeWav(args.outputAudio, SAMPLE_RATE)),
      AUDIO_UPLOAD_TIMEOUT_MS,
    );
    if (uploaded === DEADLINE) {
      args.errors.push(
        `output audio upload failed: no response within ${AUDIO_UPLOAD_TIMEOUT_MS} ms`,
      );
      return undefined;
    }
    return uploaded.outputAudioPath;
  } catch (cause) {
    args.errors.push(
      `output audio upload failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return undefined;
  }
}

/**
 * TICKET 046 ROUND 3 (R3-1) — waits for the transport's audio contexts, but
 * NEVER LONGER THAN THE BUDGET.
 *
 * The wait itself is the transport's (it knows how many contexts it holds); the
 * DEADLINE is the runner's, because the runner is the only layer that owns a
 * run's lifetime. Nothing else races this: `startBatch`'s `runTimeoutMs` only
 * aborts the signal, and `runOnce` reads that signal nowhere after pacing. So an
 * unbounded await turns one wedged AudioContext into a frozen run, a sweep that
 * stops advancing, no stored Run and no reported error — strictly worse than the
 * leaked context it was protecting against.
 *
 * THE TIMER IS CLEARED ON THE WINNING PATH. A `Promise.race` that leaves its
 * handle armed costs one live 2 s timer per run, which is 60 of them in a sweep
 * and a fake-timer teardown that lies about what is still pending.
 */
async function closeTransport(
  stop: () => void | Promise<void>,
  timeoutMs: number,
): Promise<void> {
  // ROUND 4 (R4-2) — A THUNK, so the CALL is inside the guard too.
  //
  // The rejection guard below and the race guard after it both cover the promise
  // `stop()` returns; neither covers `stop()` THROWING. A synchronous throw — a
  // mock, an older or patched implementation, an AudioContext method that throws
  // on a removed device — would propagate straight out of `runOnce`, so no Run is
  // POSTed and the measurement is lost. That is exactly the trade the comments
  // around this refuse twice: giving up on a CONTEXT must never cost the RUN.
  let closing: void | Promise<void>;
  try {
    closing = stop();
  } catch {
    return;
  }
  // Nothing to wait for: a transport that closes no context (cascade, every
  // fixture) must not pay a microtask, let alone arm a timer.
  if (closing === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    // A close that rejects is not something a run can act on; giving up on the
    // context must never lose the measurement.
    Promise.resolve(closing).catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
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
  // TICKET 048 ROUND 3 (R3-3) — ABORT-AWARE. A handshake that never lands would
  // otherwise hold a transport (Arm A: two AudioContexts) for as long as it takes
  // — forever, in the case this exists for — after the sweep has abandoned the
  // attempt. Nothing else changes: a rejecting `start()` still loses its stage,
  // and on an abort the pacer below no-ops on the same signal, `cancelled` is
  // re-read, and the run falls into the existing teardown.
  await untilSettledOrAborted(transport.start(transportConfig), signal);

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

  // TICKET 048 ROUND 2 (R2-1) — a SNAPSHOT, and deliberately re-taken below.
  // Every later decision (upload, POST, the reported verdict) reads the signal
  // again at the instant it decides, because an abort raised after this line is
  // the caller writing this attempt off.
  let cancelled = signal?.aborted ?? false;
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
  //
  // TICKET 048 — AND THE WAIT IS BOUNDED. 031's idle deadline caps only a
  // MANIFEST-BACKED run; a mic-shaped one arms neither 031 timer, so a transport
  // that goes quiet without ever completing its utterance froze the run
  // "running" forever, stored no Run and reported no error. This deadline is
  // deliberately longer than SEGMENTATION_IDLE_MS, so a manifest-backed run
  // still fails with its own NAMED segmentation reason and this blunter one
  // never pre-empts it.
  //
  // UNLIKE THE UPLOAD, THIS ONE IS FATAL. A run that gave up waiting never saw
  // its utterance complete, so it cannot know it observed the whole answer:
  // `audio_queued` may belong to a partial answer and the transcripts may be
  // mid-stream. That is not a measurement, and `status: 'failed'` is what keeps
  // it out of every aggregate — through `isAggregatableRun`'s EXISTING clause,
  // never a second gate beside it. The Run is still STORED: a failure is real
  // information (PRD §12), and a hang that stored nothing was half of what made
  // this defect invisible.
  //
  // IT IS ITS OWN BUDGET, NOT A WRAPPER. The close deadline below runs after it
  // IN SERIES rather than nested inside it, so a run wedged on both pays both
  // and neither budget silently absorbs the other.
  //
  // ROUND 2 (R2-1/R2-2) — AND THE ABORT IS AN OPERAND OF IT, so a caller that
  // gives up while the run is parked here gets the transport back at its next
  // await instead of at this budget's end. An aborted wait is a CANCELLATION,
  // never a timeout: no named reason is recorded for it.
  if (!cancelled && !failed) {
    const completed = await withDeadline(
      () => untilSettledOrAborted(finished.then(() => true as const), signal),
      RUN_COMPLETION_TIMEOUT_MS,
    );
    if (completed === DEADLINE) {
      failed = true;
      errors.push(`${RUN_COMPLETION_TIMED_OUT} after ${RUN_COMPLETION_TIMEOUT_MS} ms`);
    }
    // THE RE-READ. One line, covering the upload skip, the POST gate and the
    // verdict this run reports — not three gates that could drift apart.
    cancelled = signal?.aborted ?? false;
  }
  // Belt and braces for the paths that never awaited `finished` at all.
  disarm();

  // TICKET 046 ROUND 2 (R2-7) — AWAITED. A realtime run holds two AudioContexts
  // (the outbound sink and the inbound tap, both awaited since R3-6) and Chrome
  // caps concurrent ones at roughly six, so a sweep that starts the next run
  // before this one's contexts are really gone eventually makes a construction
  // throw and kills a run. Every transport that closes nothing still returns
  // void, and that path costs nothing at all.
  //
  // ROUND 3 (R3-1) — and BOUNDED. See closeTransport: a wedged context must cost
  // a leak, never the run.
  await closeTransport(() => transport.stop(), TRANSPORT_CLOSE_TIMEOUT_MS);

  // TICKET 046 — the transport's OWN captured output audio, for the arm whose
  // audio never reaches `onAudio` at all: over WebRTC the model's voice rides
  // the media track, so Arm A buffers zero chunks here and 045's upload path
  // had nothing to give the store. Read AFTER stop(), when the capture is
  // finished, and used only when the data-channel path produced NOTHING — a
  // decoded sample always wins, so cascade is byte-for-byte unchanged.
  //
  // It is deliberately NOT routed through `onAudio`: that handler is what
  // stamps `firstAudioAt`, and feeding it here would silently re-anchor Arm A's
  // headline latency to the moment the run happened to drain a buffer.
  if (audioChunks.length === 0) {
    const captured = transport.takeOutputAudio?.();
    if (captured !== undefined && captured.length > 0) audioChunks.push(captured);
  }

  // TICKET 046 ROUND 3 (R3-7) — THE CAPTURE PATH DIAGNOSES ITSELF.
  //
  // Capture hangs off `output_audio_buffer.started`, so a gate that never opened
  // stores an artifact byte-identical to a model that never spoke. AC1 is the
  // one criterion vitest cannot prove and is conceded to an operator smoke test
  // in real Chrome; a smoke test that cannot separate those two does not confirm
  // AC1, it only fails to contradict it.
  //
  // ROUND 4 (R4-1) — THE STATS ALONE DO NOT NAME THE FAULT, and the earlier
  // condition (`saw samples AND admitted none`) assumed they did. It assumed an
  // honestly-silent run reports `{ 0, 0 }` — true of the `mute` fixture, which
  // hands the tap nothing, and FALSE in Chrome: once the ScriptProcessor is
  // connected the graph is pulled continuously and the receiver renders silence
  // frames whether or not any RTP arrives. `{ 0, 0 }` is therefore essentially
  // unreachable for a connected run, and BOTH "the gate is stuck" and "the model
  // never spoke" present as `{ n, 0 }` — the two cases this line exists to
  // separate. Labelling the second one "capture" points the operator at the tap
  // when the cause is the model.
  //
  // `timings.audio_queued` is what separates them, and it is still the
  // transport's `output_audio_buffer.started` mark at this point (it is
  // overwritten a few lines below). So the condition is: THE MODEL DEMONSTRABLY
  // STARTED AN OUTPUT BUFFER AND NOTHING WAS ADMITTED. A cancelled run is exempt
  // too — capture was still open for business when the run was taken away from
  // it, so `{ n, 0 }` says nothing about the gate.
  //
  // `undefined` stays excluded for its own reason: a transport with no capture
  // path at all — cascade, and every fixture. Reading an absent seam as "saw a
  // track, admitted nothing" would stamp this on every cascade run that happened
  // to fall silent.
  //
  // IT IS A DIAGNOSTIC, NOT A VERDICT. It rides `errors` exactly as 045's upload
  // failure does and leaves `status` alone: aggregation (exportResults,
  // results/derive, the batch runner, ReplayView) gates on `status === 'complete'`
  // and never on `errors`, so a diagnostic that flipped the status would silently
  // disqualify runs from every figure — far worse than the blind spot it closes.
  const captureStats = transport.outputAudioStats?.();
  if (
    captureStats !== undefined &&
    captureStats.dropped > 0 &&
    captureStats.admitted === 0 &&
    // The model demonstrably STARTED an output buffer. Still the transport's own
    // mark at this point — it is resolved a few lines below — and it is the only
    // thing separating a stuck gate from a model that never spoke.
    typeof timings.audio_queued === 'number' &&
    // ...and nobody took the run away from capture mid-answer.
    !cancelled
  ) {
    errors.push(
      `${CAPTURE_GATE_NEVER_OPENED}: saw ${captureStats.dropped} samples on the track, ` +
        `admitted ${captureStats.admitted}`,
    );
  }

  const outputAudio = concatPcm(audioChunks);
  timings.speech_end = t0 + recording.speechEndMs;
  // TICKET 040 — a decoded PCM sample wins, then a transport-sent mark (the
  // WebRTC media-track case, where nothing is ever decoded), then null. Before
  // this the mark was overwritten with a null firstAudioAt, so every Replay
  // Arm A run counted toward n and cost while contributing no latency sample.
  const markedAudioQueued = typeof timings.audio_queued === 'number' ? timings.audio_queued : null;
  timings.audio_queued = firstAudioAt ?? markedAudioQueued;

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

  // TICKET 045 — THE AUDIO IS UPLOADED BEFORE THE RUN IS POSTED, so the id has
  // to be minted first: the upload is addressed by it.
  const id = deps.newId();
  const outputAudioPath = await uploadOutputAudio({
    runs: deps.runs,
    id,
    outputAudio,
    // A cancelled run is not POSTed, so it stores nothing either — there is no
    // record for the bytes to belong to.
    skip: cancelled,
    errors,
  });

  // TICKET 048 ROUND 2 (R2-1) — THE LAST RE-READ, at the instant the decision to
  // WRITE is taken. The upload is the longest wait left in a run, so an abort
  // very often lands inside it; a run that treated "I already have the numbers"
  // as licence to POST would put a second aggregatable sample of this repetition
  // in an append-only ledger beside the one its retry writes.
  cancelled = cancelled || (signal?.aborted ?? false);
  // Recorded HERE rather than earlier so a late cancellation says so too. It is
  // ordered after the upload line for the same reason, and the two can only
  // co-occur on this late path — a run cancelled before the upload skips it.
  if (cancelled) errors.push('run cancelled');

  const run: Run = {
    id,
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

  // Only ever the path the SERVER reported, and only when it really reported
  // one: `outputAudioPath` is a report of bytes on disk, never a promise.
  if (outputAudioPath !== undefined) run.outputAudioPath = outputAudioPath;

  // TICKET 033 — the corpus version travels with the measurement. Only when the
  // Recording declares one: an absent version stays absent rather than becoming
  // a default nobody can ever take back out of an append-only ledger.
  if (recording.corpusVersion !== undefined) {
    run.annotations = { ...run.annotations, corpusVersion: recording.corpusVersion };
  }

  // A failure is real information and is stored like any other run (PRD §12).
  // A cancellation is not: see the header.
  //
  // TICKET 048 ROUND 3 (R3-1) — AND THE POST IS BOUNDED, which is a stronger
  // claim than "the run does not hang". This is the one wait the abort re-read
  // above cannot rescue: the re-read is immediately BEFORE this line, so an
  // abort landing while the POST is in flight is too late to stop it, the sweep
  // retries the attempt it abandoned, and BOTH rows reach the append-only ledger
  // with `origin: 'sweep'` and the same `annotations.repIndex`. Bounding it
  // REMOVES that window rather than policing it: every budget one run can spend
  // sums to less than the sweep's per-run patience (asserted as a guard beside
  // the constants), so the attempt always RETURNS before it can be abandoned,
  // and an attempt that is never abandoned is never retried.
  //
  // A POST that goes unacknowledged costs the ROW, not the measurement — 045's
  // verdict again, and for 045's reason: the pipeline did its job, the store did
  // not, and every mark, transcript and cost figure is already in hand. A
  // rejecting `create` still throws exactly as it always did.
  if (!cancelled) {
    const acknowledged = await withDeadline(() => deps.runs.create(run), RUN_POST_TIMEOUT_MS);
    if (acknowledged === DEADLINE) {
      // `errors` is the array `run.errors` already references, so the returned
      // record carries the reason even though the body on the wire could not.
      errors.push(`${RUN_POST_TIMED_OUT} ${RUN_POST_TIMEOUT_MS} ms`);
    }
  }

  return {
    run,
    outputAudio,
    audioReady: outputAudio.length > 0,
    t0,
    speechEndMs: recording.speechEndMs,
    cancelled,
  };
}
