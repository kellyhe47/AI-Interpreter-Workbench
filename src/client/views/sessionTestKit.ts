/**
 * Ticket 012 — shared test kit for the Live view suite (LOCKED test
 * infrastructure — part of the test set, not implementation).
 *
 * One fixture-script helper + fake-deps factory shared by LiveView.test.tsx,
 * LiveView.flow.test.tsx and App.test.tsx.
 *
 * Everything renders through <App deps={...} /> so TopBar assertions (live
 * dot, provenance) run against the real composition. All browser seams are
 * faked here: FixtureTransport factories, capture fakes, a fake playback
 * AudioContext, and a controllable clock — RTL never touches real browser
 * audio APIs.
 *
 * ONE ARCHITECTURE PER SESSION (ticket 012): the deps bag hands the
 * controller a single transport at a time, built from the resolved
 * LiveRunConfig. Scripts are therefore keyed by ARCHITECTURE, not by arm id,
 * and every config the factory received is recorded in `configs` so tests can
 * assert what was actually configured (notably the resolved realtime model).
 *
 * NOTE on realness: records delivered by the fixture SCRIPTS are
 * "real-looking" (non-fixture providers, non-placeholder corpus) on purpose —
 * the ledger's realness rule must not filter them out, because this ticket
 * asserts that footer figures come from ledger aggregates.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { vi } from 'vitest';
import App from '../App';
import type { Mode, UtteranceRecord } from '../../core/timing';
import type { CaptureResult } from '../audio/capture';
import type { PlaybackAudioContextLike, PlaybackSourceLike } from '../audio/playback';
import { RunLedger } from '../state/ledger';
import type { SessionState } from '../state/sessionMachine';
import { FixtureTransport, type FixtureScriptEvent } from '../transport/fixture';
import type { CaptureCallbacks, LiveRunConfig, SessionDeps } from './useSessionController';

// ---------------------------------------------------------------------------
// Locked copy (single source of truth for copy assertions)
// ---------------------------------------------------------------------------

export const COPY = {
  purposeLine:
    'One architecture, voice in → voice out, up to 5 minutes. Metrics are saved; audio is discarded. Nothing here becomes experimental evidence.',
  idleTitle: 'No active session',
  // Ticket 017: default mode is Realtime (design-mock initial state governs).
  idleSubline:
    'English → Spanish · Realtime · autoplay on · up to 5 minutes. Your browser will ask for microphone permission.',
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
  /** Mock: liveFailText — the architecture asymmetry is a PRD finding. */
  cascadeFail: 'mt stage timed out for this utterance — session still running',
  realtimeFail: 'opaque failure — no stage attribution · session still running',
  ctxNoteDefault: 'full conversation replayed each turn — cost climbs with session length',
  ctxNoteTrimmed: 'history deleted after each response — flat cost, measured against default',
  // TICKET 051 — Live no longer renders `endpointing` (it needs corpus ground
  // truth for when the human stopped, which Live has none of) and Arm A no
  // longer renders a separate `queue` (over WebRTC there is no observable
  // instant between "model produced audio" and "audio queued"). The note has
  // to count what is actually on the card.
  cascadeIntervals: '3 intervals · all visible',
  realtimeIntervals: '1 interval · opaque',
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
export function makeRecord(overrides: Partial<UtteranceRecord> = {}): UtteranceRecord {
  return {
    id: 'utt-0',
    arm: 'B',
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
    providers: { stt: 'gpt-4o-transcribe', mt: 'gpt-4o-mini', tts: 'gpt-4o-mini-tts' },
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
}

/** One complete cascade utterance: partials → final → deltas → final →
 * timing marks → audio → utteranceComplete carrying the full record. */
export function cascadeUtteranceScript(opts: UtteranceScriptOptions = {}): FixtureScriptEvent[] {
  const utt = opts.utt ?? 0;
  const base = opts.base ?? 0;
  const t = cascadeTimings(base);
  return [
    { at: base + 10, type: 'sourceText', kind: 'partial', text: SRC_PARTIAL_1, utt },
    { at: base + 40, type: 'sourceText', kind: 'partial', text: SRC_PARTIAL_2, utt },
    { at: base + 500, type: 'timing', event: 'speech_end', t: t.speech_end, utt },
    { at: base + 505, type: 'timing', event: 'vad_fired', t: t.vad_fired, utt },
    { at: base + 560, type: 'sourceText', kind: 'final', text: SRC_FINAL, utt },
    { at: base + 565, type: 'timing', event: 'stt_final', t: t.stt_final, utt, stage: 'stt' },
    {
      at: base + 850,
      type: 'timing',
      event: 'mt_first_token',
      t: t.mt_first_token,
      utt,
      stage: 'mt',
    },
    { at: base + 900, type: 'targetText', kind: 'delta', text: TGT_DELTA_1, utt },
    { at: base + 950, type: 'targetText', kind: 'delta', text: TGT_DELTA_2, utt },
    {
      at: base + 1041,
      type: 'timing',
      event: 'tts_first_byte',
      t: t.tts_first_byte,
      utt,
      stage: 'tts',
    },
    { at: base + 1050, type: 'targetText', kind: 'final', text: TGT_FINAL, utt },
    { at: base + 1055, type: 'audio', pcm: audioChunk(), utt },
    { at: base + 1060, type: 'timing', event: 'audio_queued', t: t.audio_queued, utt },
    {
      at: base + 1100,
      type: 'utteranceComplete',
      record: makeRecord({ id: `utt-${utt}`, timings: t }),
    },
  ];
}

/** One complete realtime utterance: completion is {utt, usage} — the client
 * assembles the record from accumulated transcripts + timing marks. */
export function realtimeUtteranceScript(opts: UtteranceScriptOptions = {}): FixtureScriptEvent[] {
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
  /** FixtureTransport script per ARCHITECTURE ('realtime' | 'cascade'). */
  scripts?: Partial<Record<Mode, FixtureScriptEvent[]>>;
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
  /** Every LiveRunConfig the factory received, in order. */
  configs: LiveRunConfig[];
  capture: (cbs: CaptureCallbacks) => Promise<CaptureResult>;
}

export function makeDeps(opts: TestDepsOptions = {}): TestDeps {
  const ledger = opts.ledger ?? new RunLedger();
  const capture = opts.capture ?? makeGrantingCapture().fn;
  const transports: FixtureTransport[] = [];
  const configs: LiveRunConfig[] = [];
  const deps: SessionDeps = {
    transportFactory: (config) => {
      configs.push(config);
      const transport = new FixtureTransport({
        armId: 'live',
        kind: config.architecture,
        label: config.architecture === 'realtime' ? 'Realtime' : 'Cascade',
        script: opts.scripts?.[config.architecture] ?? [],
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
  return { deps, ledger, transports, configs, capture };
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
// DOM query helpers (data-attribute test hooks; see LiveView.tsx contract)
// ---------------------------------------------------------------------------

function get(selector: string): HTMLElement {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`expected element matching ${selector}`);
  return el as HTMLElement;
}

function query(selector: string): HTMLElement | null {
  return document.querySelector(selector) as HTMLElement | null;
}

/** Collapses runs of whitespace so a copy assertion is not JSX-node-shaped. */
export function text(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export const micIndicator = (): HTMLElement => get('[data-mic-indicator]');
export const connLabel = (): HTMLElement => get('[data-conn]');
export const stateLabelEl = (): HTMLElement => get('[data-state-label]');
export const elapsedLabel = (): HTMLElement => get('[data-elapsed]');
export const inputMeter = (): HTMLElement => get('[data-input-meter]');
export const sourceCard = (): HTMLElement => get('[data-source-card]');
export const targetCard = (): HTMLElement => get('[data-target-card]');
export const sessionFooter = (): HTMLElement => get('[data-session-footer]');
export const liveDot = (): HTMLElement | null => query('[data-live-dot]');
export const deniedCard = (): HTMLElement | null => query('[data-denied-card]');
export const armTagPill = (): HTMLElement => get('[data-arm-tag]');
export const contextPolicyRow = (): HTMLElement | null => query('[data-context-policy]');

export function stageSelect(stage: 'stt' | 'mt' | 'tts'): HTMLElement | null {
  return query(`[data-stage-select="${stage}"]`);
}

export function targetCards(): HTMLElement[] {
  return [...document.querySelectorAll('[data-target-card]')] as HTMLElement[];
}

export function stageRow(card: HTMLElement, label: string): HTMLElement | null {
  return card.querySelector(`[data-stage-row="${label}"]`) as HTMLElement | null;
}
