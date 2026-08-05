/**
 * Ticket 012 — shared test kit for the Session view suite (LOCKED test
 * infrastructure — part of the test set, not implementation).
 *
 * One fixture-script helper + fake-deps factory shared by
 * SessionView.test.tsx, SessionView.flow.test.tsx, and App.test.tsx.
 *
 * Everything renders through <App deps={...} /> so TopBar assertions (live
 * dot, provenance) run against the real composition. All browser seams are
 * faked here: FixtureTransport factories, capture fakes, a fake playback
 * AudioContext, and a controllable clock — RTL never touches real browser
 * audio APIs.
 *
 * NOTE on realness: records delivered by the fixture SCRIPTS are
 * "real-looking" (non-fixture providers, non-placeholder corpus) on
 * purpose — the ledger's realness rule must not filter them out, because
 * ticket 012 asserts that footer figures come from ledger aggregates. The
 * FixtureTransport is only the delivery mechanism.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { vi } from 'vitest';
import App from '../App';
import type { UtteranceRecord } from '../../core/timing';
import type { CaptureResult } from '../audio/capture';
import type { PlaybackAudioContextLike, PlaybackSourceLike } from '../audio/playback';
import { RunLedger } from '../state/ledger';
import type { SessionState } from '../state/sessionMachine';
import { FixtureTransport, type FixtureScriptEvent } from '../transport/fixture';
import type { CaptureCallbacks, SessionDeps } from './useSessionController';

// ---------------------------------------------------------------------------
// Locked copy (single source of truth for copy assertions)
// ---------------------------------------------------------------------------

export const COPY = {
  idleTitle: 'No active session',
  idleSubline:
    'English → Spanish · Cascade · autoplay on. Your browser will ask for microphone permission.',
  micNotRequested: 'mic not requested',
  micRequesting: 'mic prompt open…',
  micGranted: 'mic allowed',
  micDenied: 'mic blocked',
  deniedHeading: 'Microphone blocked',
  /** Exact re-prompt phrase chosen for the denied card. */
  noRePrompt: 'do not re-prompt',
  cantoTargetWarn:
    'Realtime does not list Cantonese as a supported output language — the run proceeds to observe the actual failure mode. Text may look correct while audio pronunciation is not.',
  cantoInputWarn:
    'Realtime does not document Cantonese speech input — recognition quality in this direction is unverified. The run proceeds to observe actual behavior.',
  multiArmNote: 'autoplay off — two arms would talk over each other',
  opaqueFootnote:
    'model interval is opaque — recognition, translation and voice happen inside one model · source transcript comes from a parallel recognizer, not the model itself',
  realtimeFail: 'opaque failure — no stage attribution · session still running',
  disconnectedBanner:
    'Disconnected — reconnect attempts exhausted (5 of 5) · transcript history intact',
} as const;

// ---------------------------------------------------------------------------
// Transcript + timing fixtures
// ---------------------------------------------------------------------------

export const SRC_PARTIAL_1 = 'I need to schedule';
export const SRC_PARTIAL_2 = 'I need to schedule an appointment';
export const SRC_FINAL =
  'I need to schedule an appointment for next Tuesday to review the test results.';
export const TGT_DELTA_1 = 'Necesito programar';
export const TGT_DELTA_2 = ' una cita';
export const TGT_FINAL =
  'Necesito programar una cita para el próximo martes para revisar los resultados.';

/** Cascade stage widths matching the design mock: 500/42/298/201/12 = 1053. */
export function cascadeTimings(t0: number) {
  return {
    speech_end: t0,
    vad_fired: t0 + 500,
    stt_final: t0 + 542,
    mt_first_token: t0 + 840,
    tts_first_byte: t0 + 1041,
    audio_queued: t0 + 1053,
  };
}

/** Realtime stage widths matching the design mock: 500/471/9 = 980. */
export function realtimeTimings(t0: number) {
  return {
    speech_end: t0,
    server_speech_stopped: t0 + 500,
    first_audio_delta: t0 + 971,
    audio_queued: t0 + 980,
  };
}

/** Real-looking (never fixture-flagged) utterance record. */
export function makeRecord(
  overrides: Partial<UtteranceRecord> & { arm: string },
): UtteranceRecord {
  return {
    id: 'utt-0',
    mode: 'cascade',
    languagePair: 'EN↔ES',
    direction: 'en→es',
    sourcePartials: [SRC_PARTIAL_1, SRC_PARTIAL_2],
    sourceFinal: SRC_FINAL,
    targetPartials: [TGT_DELTA_1, TGT_DELTA_2],
    targetFinal: TGT_FINAL,
    audioState: 'queued',
    audioDurationMs: 2100,
    timings: cascadeTimings(0),
    speechEndSource: 'vad',
    providers: { stt: 'deepgram', mt: 'gpt-4o-mini', tts: 'elevenlabs' },
    costUnits: 0.005,
    corpusId: 'live-mic',
    runId: 'server-run',
    ...overrides,
  };
}

/** 50400 samples @ 24 kHz = 2.1 s of audio. */
export function audioChunk(): Int16Array {
  return new Int16Array(50400);
}

export interface UtteranceScriptOptions {
  utt?: number;
  /** Millisecond offset added to every `at` and every timing t. */
  base?: number;
  armId?: string;
}

/** One complete cascade utterance: partials → final → deltas → final →
 * timing marks → audio → utteranceComplete carrying the full record. */
export function cascadeUtteranceScript(
  opts: UtteranceScriptOptions = {},
): FixtureScriptEvent[] {
  const utt = opts.utt ?? 0;
  const base = opts.base ?? 0;
  const armId = opts.armId ?? 'cascade-openai';
  const t = cascadeTimings(base);
  return [
    { at: base + 10, type: 'sourceText', kind: 'partial', text: SRC_PARTIAL_1, utt },
    { at: base + 40, type: 'sourceText', kind: 'partial', text: SRC_PARTIAL_2, utt },
    { at: base + 500, type: 'timing', event: 'speech_end', t: t.speech_end, utt },
    { at: base + 505, type: 'timing', event: 'vad_fired', t: t.vad_fired, utt },
    { at: base + 560, type: 'sourceText', kind: 'final', text: SRC_FINAL, utt },
    { at: base + 565, type: 'timing', event: 'stt_final', t: t.stt_final, utt, stage: 'stt' },
    { at: base + 850, type: 'timing', event: 'mt_first_token', t: t.mt_first_token, utt, stage: 'mt' },
    { at: base + 900, type: 'targetText', kind: 'delta', text: TGT_DELTA_1, utt },
    { at: base + 950, type: 'targetText', kind: 'delta', text: TGT_DELTA_2, utt },
    { at: base + 1041, type: 'timing', event: 'tts_first_byte', t: t.tts_first_byte, utt, stage: 'tts' },
    { at: base + 1050, type: 'targetText', kind: 'final', text: TGT_FINAL, utt },
    { at: base + 1055, type: 'audio', pcm: audioChunk(), utt },
    { at: base + 1060, type: 'timing', event: 'audio_queued', t: t.audio_queued, utt },
    {
      at: base + 1100,
      type: 'utteranceComplete',
      record: makeRecord({ arm: armId, id: `utt-${utt}`, timings: t }),
    },
  ];
}

/** One complete realtime utterance: completion is {utt, usage} — the client
 * assembles the record from accumulated transcripts + timing marks. */
export function realtimeUtteranceScript(
  opts: UtteranceScriptOptions = {},
): FixtureScriptEvent[] {
  const utt = opts.utt ?? 0;
  const base = opts.base ?? 0;
  const t = realtimeTimings(base);
  return [
    { at: base + 10, type: 'sourceText', kind: 'partial', text: SRC_PARTIAL_1, utt },
    { at: base + 500, type: 'timing', event: 'speech_end', t: t.speech_end, utt },
    {
      at: base + 505,
      type: 'timing',
      event: 'server_speech_stopped',
      t: t.server_speech_stopped,
      utt,
    },
    { at: base + 560, type: 'sourceText', kind: 'final', text: SRC_FINAL, utt },
    { at: base + 900, type: 'targetText', kind: 'delta', text: TGT_DELTA_1, utt },
    { at: base + 971, type: 'timing', event: 'first_audio_delta', t: t.first_audio_delta, utt },
    { at: base + 975, type: 'audio', pcm: audioChunk(), utt },
    { at: base + 980, type: 'timing', event: 'audio_queued', t: t.audio_queued, utt },
    { at: base + 985, type: 'targetText', kind: 'final', text: TGT_FINAL, utt },
    { at: base + 1000, type: 'utteranceComplete', record: { utt, usage: {} } },
  ];
}

// ---------------------------------------------------------------------------
// Fake deps
// ---------------------------------------------------------------------------

export function makeGrantingCapture() {
  const stop = vi.fn();
  const fn = vi.fn(
    async (_cbs: CaptureCallbacks): Promise<CaptureResult> => ({
      status: 'granted',
      handle: { stop },
    }),
  );
  return { fn, stop };
}

export function makeDenyingCapture() {
  // Mirrors startCapture's mapping of a getUserMedia NotAllowedError.
  return vi.fn(
    async (_cbs: CaptureCallbacks): Promise<CaptureResult> => ({
      status: 'denied',
      reason: 'blocked',
    }),
  );
}

/** Capture whose promise never settles — the browser prompt is "open". */
export function makePendingCapture() {
  return vi.fn((_cbs: CaptureCallbacks) => new Promise<CaptureResult>(() => {}));
}

export function makeFakePlaybackContext(): PlaybackAudioContextLike {
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

export interface TestDepsOptions {
  /** FixtureTransport script per arm id ('realtime' | 'cascade-openai' | 'cascade-best'). */
  scripts?: Record<string, FixtureScriptEvent[]>;
  capture?: (cbs: CaptureCallbacks) => Promise<CaptureResult>;
  initialState?: Partial<SessionState>;
  now?: () => number;
  ledger?: RunLedger;
}

export interface TestDeps {
  deps: SessionDeps;
  ledger: RunLedger;
  /** Every FixtureTransport the factory constructed, in order. */
  transports: FixtureTransport[];
  capture: (cbs: CaptureCallbacks) => Promise<CaptureResult>;
}

export function makeDeps(opts: TestDepsOptions = {}): TestDeps {
  const ledger = opts.ledger ?? new RunLedger();
  const capture = opts.capture ?? makeGrantingCapture().fn;
  const transports: FixtureTransport[] = [];
  const deps: SessionDeps = {
    transportFactory: (def) => {
      const transport = new FixtureTransport({
        armId: def.id,
        kind: def.mode,
        label: def.label,
        costPerMinUsd: def.costPerMinUsd,
        script: opts.scripts?.[def.id] ?? [],
      });
      transports.push(transport);
      return transport;
    },
    startCapture: capture,
    playbackContextFactory: makeFakePlaybackContext,
    ledger,
    now: opts.now ?? (() => 0),
    initialState: opts.initialState,
  };
  return { deps, ledger, transports, capture };
}

// ---------------------------------------------------------------------------
// Render + interaction helpers
// ---------------------------------------------------------------------------

export function renderApp(opts: TestDepsOptions = {}) {
  const kit = makeDeps(opts);
  const view = render(createElement(App, { deps: kit.deps }));
  return { ...kit, view };
}

/** Flush pending microtask chains (capture promise → dispatch). Safe under
 * both real and fake timers. */
export async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Advance fake timers (FixtureTransport scripts) inside act. Requires
 * vi.useFakeTimers() in the calling suite. */
export async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

export async function clickStartMicrophone(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Start microphone' }));
  await flushMicrotasks();
}

// ---------------------------------------------------------------------------
// DOM query helpers (data-attribute test hooks; see SessionView.tsx contract)
// ---------------------------------------------------------------------------

function get(selector: string): HTMLElement {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`expected element matching ${selector}`);
  return el as HTMLElement;
}

function query(selector: string): HTMLElement | null {
  return document.querySelector(selector) as HTMLElement | null;
}

export const micIndicator = (): HTMLElement => get('[data-mic-indicator]');
export const connLabel = (): HTMLElement => get('[data-conn]');
export const stateLabel = (): HTMLElement => get('[data-state-label]');
export const elapsedLabel = (): HTMLElement => get('[data-elapsed]');
export const autoplayLabel = (): HTMLElement => get('[data-autoplay-label]');
export const sourceCard = (): HTMLElement => get('[data-source-card]');
export const sessionFooter = (): HTMLElement => get('[data-session-footer]');
export const liveDot = (): HTMLElement | null => query('[data-live-dot]');
export const deniedCard = (): HTMLElement | null => query('[data-denied-card]');

export function armCard(armId: string): HTMLElement {
  return get(`[data-arm-card="${armId}"]`);
}

export function armCardIds(): string[] {
  return [...document.querySelectorAll('[data-arm-card]')].map(
    (el) => el.getAttribute('data-arm-card') ?? '',
  );
}

export function armPillIds(): string[] {
  return [...document.querySelectorAll('[data-arm-pill]')].map(
    (el) => el.getAttribute('data-arm-pill') ?? '',
  );
}

export function stageRow(card: HTMLElement, label: string): HTMLElement | null {
  return card.querySelector(`[data-stage-row="${label}"]`) as HTMLElement | null;
}
