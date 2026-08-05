/**
 * Ticket 018 — dev-only browser fixture mode (STUB — tests written first).
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
 * accepts either (main.tsx selects via isFixtureMode(window.location.search)
 * and passes `fault` through). Contents:
 * - transportFactory: FixtureTransport per catalog ArmDef (armId / kind /
 *   label / costPerMinUsd taken from the def), loaded with scripted
 *   utterances: source partials + final, target deltas + final, audio, and
 *   per-stage timings — cascade arms with all FIVE cascade timestamps
 *   (endpointing/stt/mt/tts/queue derivable, deriveCascadeIntervals all
 *   non-null), the realtime arm with the THREE realtime stages
 *   (endpointing/model/queue via deriveRealtimeIntervals).
 * - Every utteranceComplete delivers a FULL UtteranceRecord whose providers
 *   are ALL 'fixture' ({ stt: 'fixture', mt: 'fixture', tts: 'fixture' })
 *   — including the realtime arm (unlike the live realtime transport's
 *   {utt, usage} completion; UtteranceCompletion permits the full record,
 *   and delivering it keeps fixture provider names on everything the
 *   controller appends, so isRealRecord is false and the ledger keeps
 *   excluding fixture records from Results/aggregates).
 * - options.fault === 'fail-mt' → the cascade-openai arm's script includes
 *   one error event { opaque: false, stage: 'mt' } (message mentions the mt
 *   stage). No fault → no error events anywhere.
 * - startCapture: "grants" WITHOUT getUserMedia — resolves
 *   { status: 'granted', handle } and emits synthetic mic activity on a
 *   timer (onLevel bars 0..5 and 480-sample Int16Array chunks) until
 *   handle.stop(); stop() halts all emission.
 * - playbackContextFactory: silent no-op PlaybackAudioContextLike
 *   (createBuffer/createBufferSource/destination/currentTime/resume/
 *   suspend all satisfied, nothing audible).
 * - ledger: fresh in-memory RunLedger (no storage adapter).
 * - now: options.now ?? Date.now.
 * ==========================================================================
 */

import type { SessionDeps } from './views/useSessionController';

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
}

export function isFixtureMode(_search: string): FixtureModeSelection {
  throw new Error('isFixtureMode not implemented (ticket 018)');
}

export function buildFixtureDeps(_options?: FixtureDepsOptions): SessionDeps {
  throw new Error('buildFixtureDeps not implemented (ticket 018)');
}
