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
 * the instant the Nth completion landed and the (N+1)th completion would never
 * be delivered. It is a window, not a guarantee — TICKET 068: an extra
 * completion can and does arrive after it expires, which is why the count is
 * taken from the BUCKETS as well (see segmentsProduced) and not from the
 * completions alone. SEGMENTATION_IDLE_MS is armed ONCE,
 * WHEN PACING COMPLETES, and catches "too few": a VAD that MERGED two utterances
 * simply delivers N-1 completions and goes quiet, so the settle window never
 * arms and the run would otherwise never resolve. Arming it at pacing end rather
 * than at run start is what keeps it from truncating the clip, and 5 s of
 * post-clip patience is what keeps it from killing a slow-but-valid final
 * utterance. Both are disarmed on EVERY exit — completion, lost stage,
 * cancellation — so no run leaves a timer pending behind it.
 *
 * THE RUN-LEVEL `timings` / `transcripts` / `cost` KEEP TODAY'S SEMANTICS
 * VERBATIM (flat last-mark-wins, last final transcripts, whole-clip cost) —
 * except the ONE pair ticket 055b corrected, below.
 *
 * ------------------- TICKET 055b: THE ENVELOPE SPEAKS FOR ONE UTTERANCE ----
 * The run-level `speech_end` / `audio_queued` pair used to be assembled from
 * two DIFFERENT utterances: `t0 + recording.speechEndMs` (the LAST utterance's
 * speech end) against `firstAudioAt` (the FIRST utterance's audio). On run
 * 7acb0cc9 that reported 885175 − 899148 = −13973 ms for a run in which no
 * single utterance was off by anything like that. Both marks are the runner's
 * own and both are on one clock — it is last-wins against first-wins, not a
 * two-clock problem — so a manifest-backed run now COPIES the LAST record's two
 * marks, and a run with no records (mic-shaped, mismatched, cancelled) keeps
 * the whole-clip pair unchanged.
 *
 * AND NO RECORD MAY REPORT AUDIO BEFORE ITS OWN SPEECH END. Utterances 3 and 4
 * of that run each answered before their own manifest anchor (−1435 / −2364 ms)
 * — a separate defect from the envelope, and fixing either alone leaves the
 * other in place. Such a mark is refused and stored as `null` ("not measured"),
 * NEVER clamped to 0, with the instant it saw named in the record's `errors`.
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
 * ------------------- TICKET 069: TRIM TRANSMISSION, NOT TIME ---------------
 * The clip's LEADING SILENT FRAMES are never handed to the transport (see
 * `leadingSilenceFrames` and `RunnerDeps.trimLeadingSilence`), because a
 * Whisper-family STT invents a foreign-language sentence out of non-speech and
 * that invented segment consumes bucket 0, shifting every real utterance late.
 *
 * THE PACING CLOCK DOES NOT MOVE. The pacer is handed the WHOLE clip, `t0` is
 * still epoch-ms of frame 0, and frame k is still due at `t0 + k * FRAME_MS`;
 * the withheld frames are dropped at the moment they come due, so the frames
 * after them keep their own due times and the run still spans one clip-length.
 * Trimming the CLIP instead would shift the audio against `t0 +
 * trueSpeechEndMs` and improve every latency in the project by exactly the
 * silence removed — a corruption that looks like a small, consistent win.
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
import { PRICING_VERSION, priceRealtimeUsage } from '../../core/pricing';
import { readWav, writeWav } from '../../harness/wav';
import { ENDPOINTING_MS, SAMPLE_RATE } from '../../core/protocol';
import { CLOCK_INVERSION } from '../../core/timing';
import type { InterpreterTransport, TransportConfig } from '../transport/types';
import type { Recording, Run, RunUtterance } from '../state/ledger';
import { ApiError } from './recordingsClient';
import {
  FRAME_MS,
  FRAME_SAMPLES,
  createPacer,
  leadingSilenceFrames,
  type Pacer,
  type PacerDeps,
} from './pacer';
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
 * 5 s WAS WRONG, and the reason is worth keeping. It was justified as
 * "comfortably longer than any answer a healthy pipeline still owes once the
 * clip has finished playing" — which assumes the pipeline is roughly keeping up
 * with the clip. THE CASCADE IS SEQUENTIAL AND DOES NOT: `runCascade` opens the
 * next utterance's STT only after the previous utterance's TTS has finished, so
 * the pipeline runs progressively BEHIND the audio and the last utterance's
 * whole STT -> MT -> TTS chain begins after the clip is already over. The lag
 * therefore GROWS with utterance count and with provider latency; it is not
 * bounded by anything the clip's length tells you.
 *
 * Measured on EN Take 1 (4 utterances, 20.7 s) against production on
 * 2026-08-10, timestamps relative to the socket opening:
 *
 *   utt 3  stt.final 23.3 s · mt.final 24.5 s · utterance.complete 26.3 s
 *   pacing (clip + trailing pad) ended at ~22.2 s
 *
 * The final completion landed 4.1 s after pacing — INSIDE the old 5 s window by
 * 0.9 s. Two identical runs minutes apart therefore disagreed: one stored four
 * utterances, the other failed `observed 3` on provider-latency jitter alone.
 * A gate that flips on a second of vendor variance is not measuring
 * segmentation, and a FAILED run is not a neutral outcome — it is excluded from
 * every aggregate, so the flake silently shrinks n.
 *
 * 12 s WAS ALSO TOO SHORT, and the second measurement says why. On EN Take 2
 * (24.1 s) Arm A and Arm B complete all four utterances while ARM C fails every
 * time at `observed 2`, its last transcript stranded on utterance 2. B and C
 * differ in the TTS STAGE ALONE — same STT, same MT, same audio, same
 * endpointing — so segmentation is not the problem and neither is the
 * recording: ElevenLabs simply does not finish the tail utterances inside the
 * window. Arm C passed on EN Take 1 (20.7 s) and fails on the 24.1 s take,
 * which is the lag growing with clip length exactly as this comment describes.
 * The corpus's ES takes run 38-47 s, so without more headroom Arm C would
 * produce NOTHING on four of six recordings and Experiment 2 would lose its
 * second column for most of the study.
 *
 * 20 s is 80x the settle window. It is informed rather than measured — Arm C
 * loses two utterances, each needing a full STT -> MT -> TTS chain of roughly
 * 5 s — and if it is still short the failure is unchanged and says so. It stays
 * BELOW RUN_COMPLETION_TIMEOUT_MS (30 s), the ordering that matters, since a
 * manifest-backed run must fail with its own NAMED segmentation reason rather
 * than the blunter completion timeout; and even on a 47 s ES take, 47 + 20 sits
 * far under the batch runner's 120 s per-run patience (browserDeps
 * RUN_TIMEOUT_MS), so a genuinely merged clip is still named long before the
 * sweep's blunt abort fires. The cost of the larger window is paid ONLY by runs
 * that are going to fail anyway.
 *
 * It applies ONLY when the Recording carries a manifest; a manifest-less run's
 * termination is byte-for-byte unchanged, hang included.
 */
export const SEGMENTATION_IDLE_MS = 20_000;

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
 * THE CLIP ENDS BEFORE THE TURN DOES — trailing silence appended at replay.
 *
 * A provider's VAD closes a turn only after it OBSERVES `ENDPOINTING_MS` of
 * silence. A recording carries whatever silence the operator left before they
 * hit stop, and on 2026-08-10 that was 21–640 ms across five of six corpus
 * takes. So the stream ended before the last turn could endpoint: the final
 * utterance never produced a turn-final, and every run failed
 * `segmentation: expected 4 utterances, observed 3` — on all three arms at
 * once, because all three read the same `ENDPOINTING_MS`.
 *
 * NOTHING RECONCILED THE TWO ENDS BEFORE THIS. The manifest is built by the
 * local segmenter, which ends the last utterance at end-of-clip and needs no
 * trailing silence at all, so a take with none is ACCEPTED at record time and
 * can only fail later, in Replay, against a gate it was never measured by.
 * That is a defect in the runner, not in the recording: at 500 ms it merely
 * had a narrower blast radius (a 640 ms tail cleared it by 140 ms).
 *
 * IT IS PURE ADDITION, WHICH IS WHY IT IS MEASUREMENT-NEUTRAL. The pad goes
 * AFTER the last real frame, so frame k of the clip is still due at
 * `t0 + k * FRAME_MS`, `t0` does not move, and every manifest anchor
 * (`t0 + trueSpeechEndMs`) means exactly what it meant before. Contrast the
 * leading trim above, which had to withhold TRANSMISSION precisely because
 * moving the clip would have moved every anchor with it.
 *
 * The margin over `ENDPOINTING_MS` is deliberate: the VAD's silence window has
 * to fit INSIDE the pad with room for jitter and the last frame's own duration,
 * and the two errors are not symmetric — an over-long pad costs half a second
 * of wall clock per run, while a pad one frame short costs the whole run.
 */
export const TRAILING_PAD_MS = ENDPOINTING_MS + 500;

/**
 * PACING IS THE MEASUREMENT, SO IT HAS TO BE CHECKED.
 *
 * PRD §7: "Replay is paced at 1x, in the same 20 ms framing as live capture.
 * Dumping the clip as fast as the socket accepts would invalidate VAD,
 * endpointing, and every latency figure." Every number this project reports
 * depends on that invariant — and NOTHING verified it at runtime.
 *
 * It is breakable by the operator without any warning at all. Chrome clamps
 * `setTimeout` to roughly ONCE PER SECOND in a hidden tab, and the pacer is
 * built on `setTimeout`. Measured in production's own tab on 2026-08-10:
 *
 *   setInterval(20 ms) in a hidden tab -> effective interval 981 ms
 *   (14 ticks where 686 were due)
 *
 * Because the pacer is wall-clock anchored it then emits every overdue frame
 * at once, so the clip still leaves in about a clip-length of wall clock — the
 * AVERAGE rate looks right — while the provider actually receives ~1 s bursts
 * instead of a 20 ms cadence. Runs complete, transcripts look sane, and every
 * latency carries up to a second of flush jitter. THAT is the dangerous shape:
 * a corruption that presents as success. A whole sweep was collected this way
 * before anyone thought to measure the timer.
 *
 * MEAN lateness is the metric, and the alternative is instructive: the SHARE of
 * late frames cannot tell throttling from one GC pause. The pacer is wall-clock
 * anchored, so a single 750 ms stall leaves every frame behind it overdue and
 * emitted in one catch-up burst — ~30% of a short clip's frames "late" from one
 * hiccup. Averaged over the clip that same stall is ~110 ms, while a throttled
 * tab sits near half the clamp (~500 ms) for the WHOLE run. The mean separates
 * a hiccup from a broken invariant; a count of late frames does not.
 *
 * So the runner now measures its own pacing and refuses to call the result
 * evidence when it drifted. `status: 'failed'` rather than a diagnostic on a
 * complete run — unlike CAPTURE_GATE_NEVER_OPENED below, bad pacing invalidates
 * the very numbers the run exists to produce, so it must leave every aggregate
 * through `isAggregatableRun`'s EXISTING clause.
 */
export const PACING_MEAN_LATENESS_MS = 250;

/** The prefix of the line a run carries when its own pacing drifted. */
export const PACING_NOT_REALTIME = 'replay pacing: clip not delivered at 1x';

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

/**
 * TICKET 062 — the reason a run that cannot name its target language is not run.
 *
 * `runOnce` used to fill the three language fields with `?? ''` and hand them to
 * the transport, so a caller that simply forgot them (ReplayView, for its whole
 * life) produced a realtime session instructed to "translate into ", a fluent
 * answer in a language nobody selected, and a Run stored `complete` with
 * `languagePair: ''`. That is run dbeb6d94, and every Arm A figure derived from
 * it is a measurement of an unrequested language.
 *
 * UNLIKE THE CAPTURE DIAGNOSTIC, THIS IS FATAL. A run whose output language
 * cannot be confirmed must not be aggregated (AC4), and `status: 'failed'` is
 * how that is enforced — through `isAggregatableRun`'s EXISTING clause, never a
 * second gate beside it. The Run is still STORED: a failure is real information
 * (PRD §12), and a run that vanished would leave the operator with the same
 * silence that hid this defect.
 */
export const RUN_NO_TARGET_LANGUAGE =
  'no target language: the run names no language to translate into and was not started';

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
  /**
   * TICKET 069 — withhold the clip's LEADING SILENT FRAMES from the transport.
   * Defaults to ON (omitted means trim); `false` is the disable control, and a
   * run with it `false` transmits the clip exactly as every run did before this
   * ticket. See TRIM TRANSMISSION, NOT TIME in the header.
   */
  trimLeadingSilence?: boolean;
  /**
   * Milliseconds of digital silence appended AFTER the clip and paced at 1x
   * like every other frame. Omitted means `TRAILING_PAD_MS` — production never
   * sets it. `0` is the disable control, reproducing exactly what every run did
   * before this change. See THE CLIP ENDS BEFORE THE TURN DOES in the header.
   *
   * It is a DURATION rather than a boolean because the pad is paced in real
   * time: a suite that ran production's 1.5 s for every one of its ~100 runner
   * cases would spend two and a half minutes asleep. Tests shrink it; two cases
   * (`TRAILING_PAD_MS` and the omitted-seam default) pin what production sends.
   */
  trailingPadMs?: number;
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
  const stub: Run = {
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
    // TICKET 052 — an abandoned run measured NOTHING, cost included.
    cost: null,
    // TICKET 059 — the SECOND construction site, under the same rule as the real
    // Run below: a record written by today's code declares today's price source,
    // whatever it measured. The figure here is `null` either way, so nothing on
    // screen moves — but a stub that omitted the stamp would be indistinguishable
    // from a pre-059 record for a reason that has nothing to do with pricing.
    pricingVersion: PRICING_VERSION,
    errors: [args.reason],
    createdAt: args.createdAt,
  };

  // TICKET 061 — THE SECOND CONSTRUCTION SITE, under the SAME rule as the real
  // Run below. An abandoned row is the only record that a rep was attempted at
  // all and it rides the arm's provenance denominator forever, so a stub that
  // cannot say which direction the sweep was running leaves the hole this
  // ticket exists to close, in the one table whose job is to report what was
  // attempted. Read off the same `config` the transport would have been started
  // with — one source, never two.
  //
  // ABSENCE STAYS ABSENCE. `''` is what `runner.ts` fills the transport config
  // with, and an empty string in an append-only ledger is a VALUE — a row
  // claiming a pair it never had. The KEY is omitted, not written blank.
  if ((config.languagePair ?? '') !== '') stub.languagePair = config.languagePair;
  if ((config.direction ?? '') !== '') stub.direction = config.direction;

  return stub;
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
  /**
   * TICKET 070 — the `response.done` usage envelope that turn reported, EXACTLY
   * as the transport handed it over. A KEY PRESENT means the transport reported
   * something (whether or not it can be priced); a key ABSENT means it said
   * nothing about that turn, and the two are different facts all the way down to
   * `cost: null` versus a blended fallback.
   *
   * Keyed by `utt` like every other bucket, and for the same reason: the
   * transport is free to interleave, so a list would re-file utterance 2's spend
   * onto utterance 0.
   */
  usage: Map<number, unknown>;
  /**
   * TICKET 053 — the cost the SERVER already computed for that turn, as it
   * arrived on `utterance.complete`.
   *
   * The cascade's three stages are metered server-side, where the usage
   * actually is: the STT's samples, the MT's usage frame, the TTS's synthesized
   * audio. `priceCascade` turns them into a per-utterance figure and puts it on
   * the wire — and the client used to drop it here, exactly as it dropped the
   * realtime `usage` envelope before ticket 070. Every cascade run therefore
   * stored `cost: null` while the server had the number in hand.
   *
   * A KEY PRESENT means the server reported a priced figure. Absent means it
   * could not price the turn, which stays `null` rather than falling through to
   * a blended rate nobody measured.
   */
  serverCost: Map<number, number>;
}

function emptyBuckets(): UtteranceBuckets {
  return {
    timings: new Map(),
    audioAt: new Map(),
    source: new Map(),
    targetFinal: new Map(),
    targetDelta: new Map(),
    usage: new Map(),
    serverCost: new Map(),
  };
}

/**
 * TICKET 070 — WHAT THE REPORTED USAGE COMES TO, PER TURN AND IN TOTAL.
 *
 * Absent when the transport reported no envelope at all, which is what leaves
 * 053's blended `costPerMinUsd` path exactly where it was.
 */
interface ReportedUsagePricing {
  /** `utt` -> the priced figure, or `null` when the envelope was REFUSED. */
  perUtterance: Map<number, number | null>;
  /** Sum of the turns that priced. NULL when none did — never 0. */
  totalUsd: number | null;
}

/**
 * TICKET 070 — PRICES THE REPORTED USAGE THROUGH THE ONE PRICE SOURCE.
 *
 * `priceRealtimeUsage` is the function the LIVE footer already calls
 * (`useSessionController`), and calling it is the whole point: its refusals — a
 * cached count with no breakdown, a breakdown contradicting its own total, an
 * envelope whose only numbers are negative, an empty one — are judgements no
 * multiply-and-sum reimplementation arrives at, and each of them is a turn that
 * must read `not measured` rather than a confident wrong figure. A second
 * pricing path here would be a second opinion about money.
 *
 * PER TURN, NEVER BLENDED. A turn nobody metered contributes NOTHING to the
 * total and carries `null` of its own; spreading the metered turns across all of
 * them would satisfy "the total is right" and "every record has a figure" at
 * once and be wrong on every record.
 *
 * A MEASURED ZERO IS A MEASUREMENT. `audio_tokens: 0` is a turn that really did
 * consume nothing, so it prices `0` and counts toward the denominator; only an
 * absent or unpriceable envelope is `null` (ticket 059's other half).
 *
 * The turns are summed in `utt` ORDER rather than arrival order, so a transport
 * that interleaves cannot move the last bits of the run's own double.
 */
function priceReportedUsage(
  usage: ReadonlyMap<number, unknown>,
  model: string,
): ReportedUsagePricing | undefined {
  if (usage.size === 0) return undefined;

  const perUtterance = new Map<number, number | null>();
  let totalUsd = 0;
  let measured = 0;
  for (const utt of [...usage.keys()].sort((a, b) => a - b)) {
    const cost = priceRealtimeUsage(usage.get(utt), model);
    const usd = cost.measured ? cost.usd : null;
    perUtterance.set(utt, usd);
    if (usd !== null) {
      totalUsd += usd;
      measured += 1;
    }
  }

  return { perUtterance, totalUsd: measured === 0 ? null : totalUsd };
}

/**
 * TICKET 068 — HOW MANY SEGMENTS THE TRANSPORT ACTUALLY PRODUCED.
 *
 * `completions` is the count of `onUtteranceComplete` events that arrived
 * BEFORE THE RUN STOPPED LISTENING, which is not the same fact. When the STT
 * hallucinates a leading utterance on the clip's opening silence (7 of the
 * operator's 17 runs: "Turn right.", "그러나.", "Hallo.", "żeśmy.", …) every
 * real utterance lands one bucket late and manifest entry N's answer lands in
 * bucket N — past everything `attributeUtterances` reads. In run 8aba8e2e the
 * Nth completion armed the 250 ms settle window, it expired, the transport was
 * torn down, and the (N+1)th completion arrived ~2.5 s later into nothing. No
 * count of completions can ever see that segment: it is announced after the
 * run has stopped listening.
 *
 * THE ONLY IN-RUN EVIDENCE IS THE BUCKET ITSELF. That segment's transcript WAS
 * delivered in time — it sits in `buckets`, keyed at `expected`, carrying
 * content nobody reads. So a bucket keyed AT OR BEYOND `manifest.length` is a
 * segment the transport demonstrably produced, whether or not it was ever
 * announced, and the highest such key names how many segments there were.
 *
 * IT IS DELIBERATELY ONE-DIRECTIONAL. Only keys `>= expected` are consulted, so
 * this cannot touch the "too few" direction: a run that delivered content on
 * `utt` 0 and never completed it still reports `observed 0` (ticket 031's own
 * message and behaviour, byte-for-byte — see runner.test.ts and
 * replayArmA.test.ts). Redefining `observed` globally as "distinct buckets
 * seen" would turn those two into `observed 1` and silently retire 031's rule.
 *
 * And it is a MAX, not a sum: a transport whose extra completion DID arrive in
 * time is already counted by 031, and adding the bucket to it would report N+2
 * segments where there were N+1.
 */
function segmentsProduced(args: {
  buckets: UtteranceBuckets;
  expected: number;
  completions: number;
}): number {
  const { buckets, expected, completions } = args;
  let highest = -1;
  const note = (utt: number): void => {
    if (utt >= expected && utt > highest) highest = utt;
  };
  // Every way a segment can leave a trace: a transcript (partial or final), its
  // output audio, or any mark it carried.
  for (const utt of buckets.source.keys()) note(utt);
  for (const utt of buckets.targetFinal.keys()) note(utt);
  for (const utt of buckets.targetDelta.keys()) note(utt);
  for (const utt of buckets.audioAt.keys()) note(utt);
  for (const utt of buckets.timings.keys()) note(utt);
  return highest < 0 ? completions : Math.max(completions, highest + 1);
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
  /**
   * TICKET 070 — what the reported usage came to, per `utt`. Absent when the
   * transport reported no usage at all (every cascade run today), which is what
   * leaves the blended split below untouched.
   */
  usageCosts?: ReadonlyMap<number, number | null>;
}): RunUtterance[] {
  const { manifest, buckets, t0, durationMs, costPerMinUsd, usageCosts } = args;
  const last = manifest.length - 1;

  return manifest.map((entry, i) => {
    const utt = entry.index - 1;

    // Marks pass through verbatim by event name, exactly as at run level...
    const timings: Record<string, number | null> = { ...(buckets.timings.get(utt) ?? {}) };
    // ...except the two the runner owns. The anchor is the MANIFEST's, never
    // the Recording's and never VAD's.
    const speechEnd = t0 + entry.trueSpeechEndMs;
    timings.speech_end = speechEnd;
    // TICKET 040 — a decoded PCM sample still wins; a transport-sent mark is
    // the fallback for the WebRTC media-track case, where the audio never
    // reaches the data channel and only the mark exists.
    const audioAt = buckets.audioAt.get(utt);
    const markedAt = typeof timings.audio_queued === 'number' ? timings.audio_queued : null;
    const observedAudioAt = audioAt ?? markedAt;
    // TICKET 055b — AN ANSWER CANNOT BEGIN SOUNDING BEFORE THE SPEECH THAT
    // PRODUCED IT ENDED. Run 7acb0cc9 stored −1435 ms and −2364 ms for its
    // third and fourth utterances, on two marks that are BOTH the runner's own
    // and BOTH on one clock, and those figures reached Results as a p50 of
    // −1.44 s. `audio_queued − speech_end` is a PERCEIVED LATENCY: a negative
    // one is not a fast run, it is the absence of a measurement.
    //
    // THE REFUSAL IS A NULL, NEVER A CLAMP. `null` is this codebase's "not
    // measured" and renders as such; clamping to the anchor would invent a 0 ms
    // measurement nothing observed, and keeping the figure would let a
    // physically impossible interval into a percentile. The instant that WAS
    // observed is named in this utterance's own `errors`, so the drift stays
    // legible rather than being quietly deleted — and the record itself
    // survives, transcripts and all.
    let audioQueued: number | null = observedAudioAt;
    const utteranceErrors: string[] = [];
    if (observedAudioAt === null) {
      utteranceErrors.push('no output audio');
    } else if (observedAudioAt < speechEnd) {
      audioQueued = null;
      utteranceErrors.push(
        `${CLOCK_INVERSION}: output audio at ${observedAudioAt} precedes its own speech_end ` +
          `${speechEnd} by ${speechEnd - observedAudioAt} ms`,
      );
    }
    timings.audio_queued = audioQueued;

    const previousEnd = i === 0 ? 0 : manifest[i - 1]!.trueSpeechEndMs;
    const spanMs = i === last ? durationMs - previousEnd : entry.trueSpeechEndMs - previousEnd;

    // TICKET 070 — `undefined` means the transport reported no usage for this
    // turn; `null` means it reported an envelope nobody could price. Read
    // through `has` rather than `get`, so a REFUSAL is not mistaken for silence.
    const reportedCost =
      usageCosts !== undefined && usageCosts.has(utt) ? (usageCosts.get(utt) ?? null) : undefined;
    // TICKET 053 — the CASCADE's own metered figure, which outranks the blended
    // $/min fallback for the same reason 070's usage envelope does: it is a
    // measurement of this turn rather than an average imposed on it. It cannot
    // collide with `reportedCost` — a run is one architecture, and only
    // realtime reports a usage envelope while only cascade reports costUnits.
    const serverCost = buckets.serverCost.has(utt) ? buckets.serverCost.get(utt)! : undefined;

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
      // TICKET 070 — THE TURN'S OWN REPORTED SPEND WINS, and it answers for
      // that turn alone: `0` when it metered a zero, `null` when the envelope
      // was absent or unpriceable. Only a turn the transport said NOTHING about
      // falls through to 053's blended $/min, which is unconfigured everywhere
      // in production and left that way on purpose.
      //
      // TICKET 052 — and a transport that declares NO rate has not measured this
      // utterance's cost either. `null` says so; `0` would report it as free.
      cost: reportedCost !== undefined
        ? reportedCost
        : serverCost !== undefined
          ? serverCost
          : costPerMinUsd > 0
            ? costPerMinUsd * (spanMs / 60_000)
            : null,
      // An utterance with no end-to-end number has none to report, which is a
      // fact about THAT utterance and not about the Run. Keyed on the RESOLVED
      // value (040): a track-carried utterance DID produce audio and must not
      // be marked failed while the run reports its latency.
      //
      // TICKET 055b — the two ways to arrive at "no number" are NOT the same
      // fact and do not share a reason: nothing sounded at all, or something
      // sounded before the speech that produced it ended. The second names the
      // instant it saw, which is the only place that evidence still exists.
      status: audioQueued === null ? 'failed' : 'complete',
      errors: utteranceErrors,
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

  // TICKET 070 — THE RUN'S OWN MODEL SNAPSHOT, minted ONCE and used both to
  // describe the run and to price it. Arm A's meter and the dev model's are
  // different rate cards (`gpt-realtime` 32/64, `gpt-realtime-mini` 10/20), so a
  // price read off a hardcoded constant would report Arm A's spend for a dev
  // run; reading the same object the Run carries makes the two unable to
  // disagree. `undefined` for a cascade run — 053 owns the cascade meters, and
  // pricing one through the realtime card would half-price Arms B and C.
  const modelSnapshots = modelSnapshotsFor(config);
  const usageModel = config.architecture === 'realtime' ? modelSnapshots.realtime : undefined;

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
    onUtteranceComplete: (record) => {
      // TICKET 070 — THE USAGE ARRIVES HERE AND USED TO BE DISCARDED ON THE
      // DOORSTEP: this handler took no parameter at all, so `realtime.ts`'s
      // `{ utt, usage }` was dropped and every Replay figure read
      // `cost measured on 0 of N samples`. Filed by `utt` like every other
      // bucket; an ABSENT `usage` key files nothing, because "the vendor said
      // nothing" and "the vendor reported an envelope" are different facts.
      if (record.utt !== undefined && record.usage !== undefined) {
        buckets.usage.set(record.utt, record.usage);
      }
      // TICKET 053 — and the cascade's SERVER-SIDE price arrives on the same
      // doorstep. Only a finite number is filed: `costUnits: null` is the
      // server saying it could NOT price the turn, and storing that as a
      // measured figure would turn "unmeasured" into "$0.00" one layer later.
      if (record.utt !== undefined && typeof record.costUnits === 'number') {
        buckets.serverCost.set(record.utt, record.costUnits);
      }
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
  // TICKET 062 — a run that cannot name its target language never starts a
  // transport. The `?? ''` above is the mechanism that shipped German, not a
  // safety net: an empty target is a nameless instruction, and a nameless
  // instruction still answers. See RUN_NO_TARGET_LANGUAGE.
  const namesTarget = transportConfig.targetLanguage.trim() !== '';
  if (!namesTarget) fail(RUN_NO_TARGET_LANGUAGE);
  // TICKET 048 ROUND 3 (R3-3) — ABORT-AWARE. A handshake that never lands would
  // otherwise hold a transport (Arm A: two AudioContexts) for as long as it takes
  // — forever, in the case this exists for — after the sweep has abandoned the
  // attempt. Nothing else changes: a rejecting `start()` still loses its stage,
  // and on an abort the pacer below no-ops on the same signal, `cancelled` is
  // re-read, and the run falls into the existing teardown.
  if (namesTarget) await untilSettledOrAborted(transport.start(transportConfig), signal);

  // TICKET 069 — TRIM TRANSMISSION, NOT TIME.
  //
  // A Whisper-family STT handed a moment of non-speech invents a sentence in
  // some language: across the operator's 17 sweep runs the FIRST stored source
  // text was "Turn right." / "그러나." / "Hallo." / "żeśmy." / "Yardımımın" in 7
  // of them, each one consuming segment 0 and shifting every real utterance one
  // slot later (the corruption ticket 068 detects). The audio it invented from
  // is the clip's opening silence.
  //
  // ⚠️ THE OBVIOUS FIX IS THE DANGEROUS ONE. Trimming the CLIP — pacing
  // `samples.subarray(onset)` — would move frame 0 forward against `t0`, and
  // every manifest anchor is `t0 + trueSpeechEndMs`. Every latency in the
  // project would improve by exactly the silence removed, which reads as a
  // small consistent IMPROVEMENT rather than as an error, and no assertion on
  // transcripts, status or `speech_end` alone can see it.
  //
  // So NOTHING here touches the pacer: the whole clip is still paced at 1x off
  // an untouched `t0`, frame k is still due at `t0 + k * FRAME_MS`, and the run
  // still spans a full clip-length of wall clock. The ONLY change is that the
  // leading silent frames are not handed to the transport when they come due.
  // The STT is therefore given nothing to hallucinate on, and every anchor
  // still means precisely what it meant before.
  const skippedFrames =
    deps.trimLeadingSilence === false ? 0 : leadingSilenceFrames(samples);
  /** Index of the frame the pacer is delivering, in the ORIGINAL clip. */
  let frameIndex = 0;

  // ...AND THE MIRROR IMAGE AT THE OTHER END (see TRAILING_PAD_MS). The clip is
  // handed to the pacer with silence APPENDED, so the provider's VAD gets the
  // full silence window it needs to close the last turn. Appending is safe in
  // exactly the way prepending would not be: every real frame keeps its due
  // time, so no anchor moves.
  const padFrames = Math.ceil((deps.trailingPadMs ?? TRAILING_PAD_MS) / FRAME_MS);
  const paced =
    padFrames === 0
      ? samples
      : (() => {
          const withPad = new Int16Array(samples.length + padFrames * FRAME_SAMPLES);
          withPad.set(samples, 0); // the tail is left as zeros: digital silence
          return withPad;
        })();

  // The clock anchor: epoch ms of frame 0. Every timing the run reports is
  // meaningful only relative to this.
  const t0 = deps.now();
  /** How far past due each frame reached the transport, summed. */
  let totalLatenessMs = 0;
  let worstLatenessMs = 0;
  pacer = createPacer({
    samples: paced,
    onFrame: (frame) => {
      const index = frameIndex;
      frameIndex += 1;
      // THE PACING CHECK (see PACING_NOT_REALTIME). Frame k is DUE at
      // `t0 + k * FRAME_MS`; how late it actually is measures the one invariant
      // every reported number rests on. Counted for withheld frames too — the
      // 069 trim changes what is transmitted, never when a frame came due.
      const lateness = Math.max(0, deps.now() - (t0 + index * FRAME_MS));
      totalLatenessMs += lateness;
      if (lateness > worstLatenessMs) worstLatenessMs = lateness;
      // Withheld, not shifted: the frames after it keep their own due times.
      if (index < skippedFrames) return;
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
  //
  // TICKET 068 — AND THE COUNT IS OF SEGMENTS THE TRANSPORT PRODUCED, not of
  // the completions that happened to arrive before the run stopped listening.
  // See segmentsProduced: an extra segment announced too late to be counted is
  // still sitting in its own bucket, and that bucket is the only evidence of it
  // that exists inside the run. The "too few" direction is untouched.
  const segments =
    expected === undefined
      ? observed
      : segmentsProduced({ buckets, expected, completions: observed });
  const mismatched = !cancelled && expected !== undefined && segments !== expected;
  if (mismatched) {
    errors.push(`segmentation: expected ${expected} utterances, observed ${segments}`);
  }

  // THE PACING VERDICT (see PACING_NOT_REALTIME). A cancelled run is exempt for
  // the same reason it is exempt from the segmentation gate: the operator ended
  // it, the pipeline did not. The share is of frames the pacer actually
  // delivered, so a run abandoned early is judged on what it managed to pace.
  const pacedFrames = frameIndex;
  const meanLatenessMs = pacedFrames === 0 ? 0 : totalLatenessMs / pacedFrames;
  const drifted = !cancelled && meanLatenessMs > PACING_MEAN_LATENESS_MS;
  if (drifted) {
    errors.push(
      `${PACING_NOT_REALTIME}: frames arrived ${Math.round(meanLatenessMs)} ms late on ` +
        `average across ${pacedFrames} frames (worst ${Math.round(worstLatenessMs)} ms) — ` +
        `every latency this run measured is suspect`,
    );
  }

  // TICKET 070 — PRICED OFF THE BUCKET, NOT OFF THE RECORDS. It sits here, above
  // `attributeUtterances`, because a MANIFEST-LESS (mic-shaped) run produces no
  // records at all and still has a total to report: a fix wired only into the
  // attribution would price a corpus run and leave every other realtime run at
  // `null`.
  const usagePricing =
    usageModel === undefined ? undefined : priceReportedUsage(buckets.usage, usageModel);

  // TICKET 053 — the cascade's own total, summed from the per-turn figures the
  // SERVER priced. `undefined` when the transport priced no turn at all, which
  // is what keeps a cascade run that metered nothing on the `null` road rather
  // than reporting a $0.00 sum of an empty set.
  const cascadeTotalUsd =
    buckets.serverCost.size === 0
      ? undefined
      : [...buckets.serverCost.values()].reduce((sum, usd) => sum + usd, 0);

  const utterances =
    manifest === undefined || mismatched || drifted || cancelled
      ? undefined
      : attributeUtterances({
          manifest,
          buckets,
          t0,
          durationMs: recording.durationMs,
          costPerMinUsd: transport.costPerMinUsd,
          usageCosts: usagePricing?.perUtterance,
        });

  // TICKET 055b — THE ENVELOPE SPEAKS FOR ONE UTTERANCE, OR FOR NONE.
  //
  // The two lines above take `speech_end` from the RECORDING (where the LAST
  // utterance's speech ends) and `audio_queued` from `firstAudioAt` (the FIRST
  // utterance's answer). On run 7acb0cc9 that pairs utterance 4's speech end
  // with utterance 1's audio and reports 885175 − 899148 = −13973 ms. Both
  // marks are the runner's own and both are on ONE clock: this is last-wins
  // against first-wins, and no same-clock assertion would ever have caught it.
  //
  // So a manifest-backed run's envelope is a COPY of one record's two marks —
  // the LAST utterance's. That is the record whose speech end sits LAST in the
  // clip, so the run-level anchor keeps its meaning while the answer paired
  // with it becomes the answer to THAT speech. It is NOT assumed to equal
  // `recording.speechEndMs`: the clip's annotated speech end is a separate
  // figure and the two need not coincide (`replayArmA.test.ts` has 4000 against
  // a last manifest anchor of 3900). The manifest's anchor is the one that
  // wins, precisely because it is the one the record was measured against —
  // reading the Recording's here would reintroduce last-wins. Copying rather
  // than recomputing is what makes the envelope unable to disagree with the
  // record it quotes: the per-utterance honesty rule in `attributeUtterances`
  // has already refused an impossible pairing, so the envelope inherits either
  // a real interval or `null` — it can no longer manufacture one of its own.
  //
  // A run with NO records (mic-shaped, a segmentation mismatch, a cancellation)
  // keeps today's whole-clip envelope byte-for-byte: it has one utterance by
  // construction, so there is nothing to mis-pair.
  const envelope = utterances?.[utterances.length - 1];
  if (envelope !== undefined) {
    timings.speech_end = envelope.timings.speech_end ?? null;
    timings.audio_queued = envelope.timings.audio_queued ?? null;
  }

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
    modelSnapshots,
    // DERIVED, never declared — a caller-supplied config.armTag is ignored.
    armTag: deriveArmTag(config),
    // Only the batch runner (ticket 009) produces 'sweep'.
    origin: 'manual',
    status: cancelled || failed || mismatched || drifted ? 'failed' : 'complete',
    timings,
    transcripts: {
      source: sourceTranscript,
      target: targetFinal ?? (targetTranscript.length > 0 ? targetTranscript : undefined),
    },
    // TICKET 070 — THE SUM OF THE TURNS THAT REPORTED, and nothing else: three
    // metered turns out of four total three turns' spend, and the fourth's
    // absence is disclosed by the denominator (`measuredCostSamples`) rather
    // than smoothed into the figure. `null` when envelopes arrived and none
    // could be priced — never a 0, which would claim the run was free.
    //
    // TICKET 052 — the blended fallback keeps its rule verbatim for a run that
    // reported no usage at all. No declared rate, no figure: Replay says
    // `not measured` rather than a `$0.00` that reads as a free run.
    //
    // TICKET 053 — AND THE CASCADE'S SUM COMES FROM ITS OWN TURNS. The two
    // clauses above are the REALTIME paths (a usage envelope) and 052's blended
    // rate; a cascade run has neither, so its total fell to `null` even after
    // every one of its utterances carried a server-priced figure. The run-level
    // total is the sum of the turns that reported, on the same rule 070 states
    // for realtime: turns that could not be priced are absent from the sum
    // rather than counted as zero, and a run where NONE could be priced reports
    // `null` instead of a $0.00 that would read as free.
    cost:
      usagePricing !== undefined
        ? usagePricing.totalUsd
        : cascadeTotalUsd !== undefined
          ? cascadeTotalUsd
          : transport.costPerMinUsd > 0
            ? transport.costPerMinUsd * (recording.durationMs / 60_000)
            : null,
    // TICKET 059 — THE PRICE SOURCE THIS RUN RAN UNDER, copied onto the record
    // at the moment of the run exactly as `corpusVersion` is. It reports the
    // SOURCE, never the figure: it is written whatever `cost` came to and
    // whatever `status` says, because a stamp conditioned on either would be a
    // restatement of them rather than the discriminator that separates "measured,
    // and it came to 0" from "written before a cost model existed". The three
    // pre-059 Runs on disk carry no stamp and must keep carrying none — that
    // absence is what makes them read `not measured` instead of `$0.000`.
    pricingVersion: PRICING_VERSION,
    utterances,
    errors,
    createdAt: deps.now(),
  };

  // Only ever the path the SERVER reported, and only when it really reported
  // one: `outputAudioPath` is a report of bytes on disk, never a promise.
  if (outputAudioPath !== undefined) run.outputAudioPath = outputAudioPath;

  // TICKET 062 — WHAT THE TRANSPORT WAS ACTUALLY TOLD, read back off the config
  // that was handed to `start()` rather than off `config` again. Ticket 061 owns
  // the fields; this owns the claim that they are not a lie — a Run that copied
  // a constant, or the operator's intent rather than the session's instruction,
  // would satisfy 061 while still describing a run that translated into
  // something else. Absent when the run named nothing: an empty string in an
  // append-only ledger is a value, and `''` is precisely what dbeb6d94 stored.
  if (transportConfig.languagePair !== '') run.languagePair = transportConfig.languagePair;
  if (transportConfig.direction !== '') run.direction = transportConfig.direction;

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
