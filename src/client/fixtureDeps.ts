/**
 * Ticket 018 — dev-only browser fixture mode.
 *
 * Makes every live-session journey reachable in a real browser without a
 * grantable microphone (PRD §7: fixture providers are for development, CI,
 * error-path tests, stability runs): `?fixture=1` swaps the production
 * browser deps for a fully-faked SessionDeps bag driven by FixtureTransport
 * scripts. This is the enabler for manual QA and a future Playwright runner.
 *
 * ============ CONTRACT (locked by fixtureDeps.test.ts) =====================
 *
 * isFixtureMode(search: string): FixtureModeSelection
 * - Parses a location.search string.
 * - '' or any query without a `fixture` param → { enabled: false } (no
 *   fault) — the PRODUCTION default; App behavior must be byte-identical
 *   to today when the flag is absent.
 * - '?fixture=1' → { enabled: true }, no fault.
 * - '?fixture=<anything else>', e.g. '?fixture=fail-mt' → { enabled: true,
 *   fault: '<value>' } — the value names an injectable scripted fault.
 *
 * buildFixtureDeps(options?: FixtureDepsOptions): SessionDeps
 * Returns the SAME shape buildBrowserDeps returns — `<App deps={...} />`
 * accepts either (App selects via isFixtureMode(window.location.search)
 * and passes `fault` through). Contents:
 * - transportFactory: FixtureTransport per LiveRunConfig (kind taken from
 *   config.architecture), loaded with scripted utterances: source partials + final, target deltas + final, audio, and
 *   per-stage timings — cascade arms with all FIVE cascade timestamps
 *   (deriveCascadeIntervals all non-null), the realtime arm with the THREE
 *   realtime stages (deriveRealtimeIntervals).
 * - Every utteranceComplete delivers a FULL UtteranceRecord whose providers
 *   are ALL 'fixture' — including realtime — so isRealRecord is false and the
 *   ledger keeps excluding fixture records from Results/aggregates.
 * - options.fault === 'fail-mt' → a CASCADE transport's script includes one
 *   error event { opaque: false, stage: 'mt' }. No fault → no errors.
 * - startCapture: "grants" WITHOUT getUserMedia and emits synthetic mic
 *   activity on a timer until handle.stop().
 * - playbackContextFactory: silent no-op PlaybackAudioContextLike.
 * - ledger: fresh in-memory RunLedger. now: options.now ?? Date.now.
 *
 * TICKET 022 — ONE SHARED UTTERANCE TIMELINE per buildFixtureDeps call:
 * in the real product every arm hears the SAME mic audio, so fixture arms
 * must never drift onto different sentences. All transports built by one
 * deps bag share a single timeline anchored when the FIRST arm starts:
 * utterance k begins at anchor + k·spacing and its source sentence is
 * SENTENCES[k % SENTENCES.length] — identical across arms (arms may differ
 * only in per-arm timings / translation shape, mock-faithful). An arm
 * started mid-session JOINS the shared timeline at the next shared
 * utterance (its first utt index > 0); it never replays from index 0, and
 * its utt numbering continues contiguously from its join point. Everything
 * else (looping, unique incrementing ids, every utterance settles, single
 * fail-mt injection, stop() halts) is unchanged.
 * ==========================================================================
 */

import type { UtteranceRecord } from '../core/timing';
import type { CaptureResult } from './audio/capture';
import type { PlaybackAudioContextLike, PlaybackSourceLike } from './audio/playback';
import { buildReplayDeps } from './browserDeps';
import { RunLedger } from './state/ledger';
import type { ReplayDeps } from './views/ReplayView';
import type { FixtureScriptEvent } from './transport/fixture';
import type {
  InterpreterTransport,
  TransportConfig,
  TransportHandlers,
  TransportKind,
} from './transport/types';
import type { LiveRunConfig, SessionDeps } from './views/useSessionController';

/**
 * Ticket 016 — what fixture mode hands <App />: the scripted SessionDeps plus
 * the REAL Replay bag (Replay needs no microphone, so there is nothing about
 * it for fixture mode to stand in for). Assignable to AppDeps.
 */
export interface FixtureDeps extends SessionDeps {
  replay: ReplayDeps;
}

export interface FixtureModeSelection {
  enabled: boolean;
  /** Named scripted fault, e.g. 'fail-mt'; absent for plain '?fixture=1'. */
  fault?: string;
}

export interface FixtureDepsOptions {
  /** Injectable scripted fault ('fail-mt' → cascade mt-stage error). */
  fault?: string;
  /** Injectable clock; defaults to Date.now. */
  now?: () => number;
  /**
   * Ticket 021 — utterances per script loop (default 8). Fixture transports
   * LOOP their utterance script indefinitely with the same spacing until
   * stop(): a QA session always has a next utterance, so boundary-dependent
   * behaviors (queued switches) stay reachable. Utterance numbering (`utt`
   * and record ids) keeps incrementing across loop wraps — unique per
   * session — and every scripted utterance settles (completion or scripted
   * failure); no dangling utterance at the wrap. Small values make loop
   * wraps cheap to observe in tests.
   */
  utterancesPerLoop?: number;
  /** Ticket 021 — ms between utterance starts (default 4000). */
  utteranceSpacingMs?: number;
}

export function isFixtureMode(search: string): FixtureModeSelection {
  const value = new URLSearchParams(search).get('fixture');
  if (value === null) return { enabled: false };
  if (value === '' || value === '1') return { enabled: true };
  return { enabled: true, fault: value };
}

// ---------------------------------------------------------------------------
// Scripted fixture utterances
// ---------------------------------------------------------------------------

/** Rotating source/target sentences (medical-interpreting theme, per mock). */
const SENTENCES: ReadonlyArray<{ src: string; tgt: string }> = [
  {
    src: 'I need to schedule an appointment for next Tuesday to review the test results.',
    tgt: 'Necesito programar una cita para el próximo martes para revisar los resultados.',
  },
  {
    src: 'Have you been taking the medication twice a day as prescribed?',
    tgt: '¿Ha estado tomando el medicamento dos veces al día según lo recetado?',
  },
  {
    src: 'The pharmacy will call you when the prescription is ready for pickup.',
    tgt: 'La farmacia le llamará cuando la receta esté lista para recoger.',
  },
];

const DEFAULT_UTTERANCE_SPACING_MS = 4_000;
const DEFAULT_UTTERANCES_PER_LOOP = 8;

/** 50400 samples @ 24 kHz = 2.1 s of (silent) fixture audio. */
function silentAudio(): Int16Array {
  return new Int16Array(50_400);
}

interface StageOffsets {
  timings: Record<string, number>;
  /** [event name, at-offset, stage?] in script order. */
  marks: Array<[string, number, string?]>;
}

/** Cascade offsets matching the design mock: 500/42/298/201/12 = 1053. */
function cascadeOffsets(base: number): StageOffsets {
  return {
    timings: {
      speech_end: base,
      vad_fired: base + 500,
      stt_final: base + 542,
      mt_first_token: base + 840,
      tts_first_byte: base + 1041,
      audio_queued: base + 1053,
    },
    marks: [
      ['speech_end', 500],
      ['vad_fired', 505],
      ['stt_final', 565, 'stt'],
      ['mt_first_token', 850, 'mt'],
      ['tts_first_byte', 1045, 'tts'],
      ['audio_queued', 1060],
    ],
  };
}

/** Realtime offsets matching the design mock: 500/471/9 = 980. */
function realtimeOffsets(base: number): StageOffsets {
  return {
    timings: {
      speech_end: base,
      server_speech_stopped: base + 500,
      first_audio_delta: base + 971,
      audio_queued: base + 980,
    },
    marks: [
      ['speech_end', 500],
      ['server_speech_stopped', 505],
      ['first_audio_delta', 975],
      ['audio_queued', 985],
    ],
  };
}

function fixtureRecord(
  config: LiveRunConfig,
  utt: number,
  sentence: { src: string; tgt: string },
  timings: Record<string, number>,
): UtteranceRecord {
  return {
    id: `utt-${utt}`,
    arm: 'fixture',
    mode: config.architecture,
    languagePair: 'EN↔ES',
    direction: 'en→es',
    sourcePartials: [sentence.src.slice(0, 18), sentence.src.slice(0, 34)],
    sourceFinal: sentence.src,
    targetPartials: [sentence.tgt.slice(0, 18), sentence.tgt.slice(18, 30)],
    targetFinal: sentence.tgt,
    audioState: 'queued',
    audioDurationMs: 2_100,
    timings: timings as UtteranceRecord['timings'],
    speechEndSource: 'vad',
    // Fixture provider names on EVERY arm (realtime included) — keeps
    // isRealRecord false so Results/aggregates never see fixture data.
    providers: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
    costUnits: 0.004,
    corpusId: 'fixture-loop',
    runId: 'fixture', // controller re-stamps with the live session run id
  };
}

/** One scripted utterance for an arm. `atBase` is the fire-time offset
 * within the current loop; `tBase` is the (monotonic, session-wide) base for
 * timestamp values so latencies stay derivable across loop wraps. `failMt`
 * replaces the back half with a stage-attributed mt error (no completion —
 * the error IS the settle). */
function utteranceScript(
  config: LiveRunConfig,
  utt: number,
  atBase: number,
  tBase: number,
  failMt: boolean,
): FixtureScriptEvent[] {
  const sentence = SENTENCES[utt % SENTENCES.length]!;
  const offsets =
    config.architecture === 'cascade' ? cascadeOffsets(tBase) : realtimeOffsets(tBase);
  const events: FixtureScriptEvent[] = [
    { at: atBase + 10, type: 'sourceText', kind: 'partial', text: sentence.src.slice(0, 18), utt },
    { at: atBase + 220, type: 'sourceText', kind: 'partial', text: sentence.src.slice(0, 34), utt },
    { at: atBase + 560, type: 'sourceText', kind: 'final', text: sentence.src, utt },
  ];

  if (failMt) {
    events.push({
      at: atBase + 900,
      type: 'error',
      message: 'mt stage timed out for this utterance',
      opaque: false,
      stage: 'mt',
    });
    return events;
  }

  for (const [event, at, stage] of offsets.marks) {
    events.push({ at: atBase + at, type: 'timing', event, t: offsets.timings[event]!, utt, stage });
  }
  events.push(
    { at: atBase + 900, type: 'targetText', kind: 'delta', text: sentence.tgt.slice(0, 18), utt },
    { at: atBase + 960, type: 'targetText', kind: 'delta', text: sentence.tgt.slice(18, 30), utt },
    { at: atBase + 1055, type: 'audio', pcm: silentAudio(), utt },
    { at: atBase + 1080, type: 'targetText', kind: 'final', text: sentence.tgt, utt },
    {
      at: atBase + 1100,
      type: 'utteranceComplete',
      record: fixtureRecord(config, utt, sentence, offsets.timings),
    },
  );
  return events;
}

interface LoopConfig {
  fault?: string;
  utterancesPerLoop: number;
  utteranceSpacingMs: number;
  now: () => number;
}

/**
 * Ticket 022 — the ONE shared utterance timeline for a buildFixtureDeps
 * call. Anchored (epoch ms) when the FIRST transport starts; utterance k
 * begins at anchor + k·spacing with source sentence SENTENCES[k % len]. A
 * transport built mid-session (an architecture switch) JOINS at the next
 * shared utterance rather than replaying the script from index 0.
 */
interface SharedTimeline {
  anchor: number | null;
}

/**
 * Ticket 021/022 — fixture transport on the SHARED utterance timeline.
 * Utterance k fires at anchor + k·utteranceSpacingMs, indefinitely until
 * stop() (the utterancesPerLoop knob is retained for compatibility, but a
 * wrap at loop-index utterancesPerLoop lands exactly at the same uniform
 * spacing, so the timeline is simply k·spacing). The first arm to start
 * anchors the timeline at utterance 0; an arm started mid-session JOINS at
 * the NEXT shared utterance index (never replays index 0) and numbers
 * contiguously from there. `utt` ids stay unique/incrementing, every
 * utterance settles inside its own slot (completion — or the one scripted
 * fail-mt error), and stop() cancels every pending timer: no events after
 * stop.
 */
class LoopingFixtureTransport implements InterpreterTransport {
  readonly kind: TransportKind;
  readonly label: string;
  readonly costPerMinUsd: number;

  private readonly config: LiveRunConfig;
  private readonly cfg: LoopConfig;
  private readonly timeline: SharedTimeline;
  private handlers: TransportHandlers = {};
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(config: LiveRunConfig, cfg: LoopConfig, timeline: SharedTimeline) {
    this.config = config;
    this.cfg = cfg;
    this.timeline = timeline;
    this.kind = config.architecture;
    this.label = config.architecture === 'realtime' ? 'Realtime' : 'Cascade';
    this.costPerMinUsd = 0;
  }

  async start(_config: TransportConfig): Promise<void> {
    this.stopped = false;
    this.handlers.onConnectionState?.('connected');
    const now = this.cfg.now();
    let firstUtt: number;
    if (this.timeline.anchor === null) {
      // First arm anchors the shared timeline at utterance 0.
      this.timeline.anchor = now;
      firstUtt = 0;
    } else {
      // Mid-session join: the NEXT shared utterance (never index 0 again).
      firstUtt = Math.max(0, Math.ceil((now - this.timeline.anchor) / this.cfg.utteranceSpacingMs));
    }
    this.scheduleUtterance(firstUtt);
  }

  private schedule(delayMs: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) fn();
    }, delayMs);
    this.timers.add(timer);
  }

  /** Schedule shared utterance k (and chain k+1 at the next slot). */
  private scheduleUtterance(utt: number): void {
    if (this.stopped || this.timeline.anchor === null) return;
    const { fault, utteranceSpacingMs } = this.cfg;
    const uttStart = this.timeline.anchor + utt * utteranceSpacingMs;
    const delay = Math.max(0, uttStart - this.cfg.now());
    // fail-mt: exactly ONE scripted mt-stage error, on the cascade-openai
    // arm's second shared utterance; everything else completes.
    const failMt = fault === 'fail-mt' && this.config.architecture === 'cascade' && utt === 1;
    const events = utteranceScript(this.config, utt, 0, utt * utteranceSpacingMs, failMt);
    for (const ev of events) this.schedule(delay + ev.at, () => this.fire(ev));
    this.schedule(delay + utteranceSpacingMs, () => this.scheduleUtterance(utt + 1));
  }

  private fire(ev: FixtureScriptEvent): void {
    const h = this.handlers;
    switch (ev.type) {
      case 'sourceText':
        h.onSourceText?.({ kind: ev.kind, text: ev.text, utt: ev.utt });
        break;
      case 'targetText':
        h.onTargetText?.({ kind: ev.kind, text: ev.text, utt: ev.utt });
        break;
      case 'audio':
        h.onAudio?.(ev.pcm, ev.utt);
        break;
      case 'timing':
        h.onTiming?.({ event: ev.event, t: ev.t ?? Date.now(), utt: ev.utt, stage: ev.stage });
        break;
      case 'utteranceComplete':
        h.onUtteranceComplete?.(ev.record);
        break;
      case 'error':
        h.onError?.({ message: ev.message, opaque: ev.opaque, stage: ev.stage });
        break;
      case 'connection':
        h.onConnectionState?.(ev.state, ev.attempt);
        break;
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  sendAudio(_pcm: Int16Array): void {
    // Fixture mode: mic audio goes nowhere (scripts drive the session).
  }

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }
}

// ---------------------------------------------------------------------------
// Silent playback + synthetic capture
// ---------------------------------------------------------------------------

function silentPlaybackContext(): PlaybackAudioContextLike {
  return {
    createBuffer: (_channels: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: (): PlaybackSourceLike => ({
      buffer: null,
      connect: () => {},
      start: () => {},
      stop: () => {},
      onended: null,
    }),
    destination: {},
    currentTime: 0,
    resume: () => {},
    suspend: () => {},
  };
}

/** Deterministic synthetic mic-level pattern (0..5 bars). */
const LEVEL_PATTERN = [2, 3, 4, 3, 2, 1, 2, 4] as const;

export function buildFixtureDeps(options?: FixtureDepsOptions): FixtureDeps {
  const now = options?.now ?? (() => Date.now());
  const loopConfig: LoopConfig = {
    fault: options?.fault,
    utterancesPerLoop: options?.utterancesPerLoop ?? DEFAULT_UTTERANCES_PER_LOOP,
    utteranceSpacingMs: options?.utteranceSpacingMs ?? DEFAULT_UTTERANCE_SPACING_MS,
    now,
  };
  // Ticket 022 — ONE shared utterance timeline per deps bag: every transport
  // built here schedules against the same anchor, so all arms are always on
  // the same utterance index / source sentence (like sharing one real mic).
  const timeline: SharedTimeline = { anchor: null };
  return {
    transportFactory: (config: LiveRunConfig) =>
      new LoopingFixtureTransport(config, loopConfig, timeline),
    // Grants WITHOUT getUserMedia; synthetic level/chunk emission on a timer
    // until stop(). Dev/QA path — never used when the flag is absent.
    startCapture: async ({ onChunk, onLevel }): Promise<CaptureResult> => {
      let stopped = false;
      let tick = 0;
      const timer = setInterval(() => {
        if (stopped) return;
        onLevel(LEVEL_PATTERN[tick % LEVEL_PATTERN.length]!);
        onChunk(new Int16Array(480));
        tick += 1;
      }, 100);
      return {
        status: 'granted',
        handle: {
          stop: () => {
            stopped = true;
            clearInterval(timer);
          },
        },
      };
    },
    playbackContextFactory: silentPlaybackContext,
    ledger: new RunLedger(), // fresh, in-memory — fixture data never persists
    now,
    // Ticket 016 — the REAL Replay bag, unfaked. Fixture mode exists because a
    // QA browser has no grantable microphone (PRD §7); Replay needs no
    // microphone, so faking its seams would only hide the actual server. The
    // Live session is scripted; Replay still talks to the real endpoints.
    replay: buildReplayDeps(),
  };
}
