/**
 * Ticket 008 — Session lifecycle state machine + four-value mic permission.
 *
 * Pure reducer: `reduce(state, event) => state`. No timers and no side
 * effects live in here; wall-clock time arrives on event payloads as `now`
 * (epoch milliseconds), matching the convention in src/core/timing.ts.
 *
 * Design decisions (locked by sessionMachine.test.ts):
 *
 * - Session states: 'idle' | 'requesting-permission' | 'permission-denied' |
 *   'listening' | 'processing' | 'ready' | 'playing' | 'reconnecting' |
 *   'disconnected' | 'stopping' | 'stopped'. "Switch queued" is NOT a state —
 *   it is the `pending` overlay field carried alongside an active status.
 * - `micPermission` is a SEPARATE four-value field ('not-requested' |
 *   'requesting' | 'granted' | 'denied') — never a boolean.
 * - Happy path: idle →START→ requesting-permission (mic 'requesting')
 *   →PERMISSION_GRANTED→ listening (mic 'granted') →SPEECH_DETECTED→
 *   processing →ARMS_SETTLED→ ready →PLAY→ playing →PLAYBACK_ENDED→ ready.
 * - SPEECH_DETECTED is accepted from both 'listening' and 'ready' (the next
 *   utterance can begin while the previous result is on screen).
 * - PLAY carries `armId` (which arm's audio is playing, kept in
 *   `playingArm`); PLAYBACK_ENDED clears it. PLAY is only meaningful from
 *   'ready'.
 * - PERMISSION_DENIED → 'permission-denied' + micPermission 'denied'; START
 *   while micPermission is 'denied' is a no-op (blocking screen).
 * - REQUEST_SWITCH(kind, label, patch) while active (listening / processing /
 *   ready / playing) only sets `pending`; UTTERANCE_BOUNDARY applies the
 *   patch (mode / langIdx / reversed) and clears `pending`. While
 *   idle/stopped the patch applies immediately and `pending` stays null.
 *   Same mechanism for all three kinds ('mode' | 'language' | 'direction').
 * - UTTERANCE_BOUNDARY also increments `utteranceCount` — the transcript
 *   preservation marker that must survive reconnect cycles.
 * - Autoplay invariants: ADD_ARM taking arms to 2 or 3 forces
 *   `autoplay: false`; ADD_ARM beyond 3 arms or with a duplicate id is
 *   ignored; REMOVE_ARM back to exactly 1 arm restores `autoplay: true`;
 *   SET_AUTOPLAY(true) is ignored while arms.length > 1 (false is always
 *   accepted).
 * - Reconnect: CONNECTION_LOST from a live state (listening | processing |
 *   ready | playing) → 'reconnecting', prior status remembered in
 *   `resumeStatus`. RECONNECT_ATTEMPT increments `reconnectAttempts` up to
 *   MAX_RECONNECT_ATTEMPTS (5); a further RECONNECT_ATTEMPT while already at
 *   the max — or an explicit RECONNECT_EXHAUSTED — moves to 'disconnected'.
 *   RECONNECTED returns to `resumeStatus`, resets attempts to 0, and leaves
 *   `utteranceCount` untouched. RECONNECT_CLICKED (manual retry from
 *   'disconnected') → 'reconnecting' with attempts reset to 0;
 *   `resumeStatus` survives 'disconnected' so a later RECONNECTED still
 *   restores the pre-drop status.
 * - STOP from any active state (requesting-permission, listening, processing,
 *   ready, playing, reconnecting, disconnected) → 'stopping', recording
 *   `stoppedAt` from the event's `now`. FLUSH_DONE carries the final summary
 *   → 'stopped'. STOP from idle/stopped is a no-op.
 * - NEW_SESSION: if micPermission is already 'granted' → straight to
 *   'listening' (browsers do not re-prompt); otherwise →
 *   'requesting-permission' with micPermission 'requesting'. Resets
 *   utteranceCount, reconnectAttempts, pending, summary, stoppedAt,
 *   playingArm, and sets startedAt = now.
 * - Defaults (createInitialState): status 'idle', micPermission
 *   'not-requested', mode 'cascade', langIdx 0 (EN↔ES), reversed false,
 *   arms ['arm-1'], autoplay true, pending null, reconnectAttempts 0,
 *   resumeStatus null, playingArm null, utteranceCount 0,
 *   startedAt/stoppedAt null, summary null. Accepts a Partial override for
 *   test setup.
 * - `reduce` never mutates its input state.
 *
 * Language/direction helpers (rule group 7) live in this file:
 * - `pairs`: [{src:'English', tgt:'Spanish'}, {src:'English', tgt:'Cantonese'}]
 * - `supportPill(langIdx)`: 'both modes' for EN↔ES, 'cascade only' for the
 *   Cantonese pair.
 * - `warnings(langIdx, reversed, modeOrArms)`: modeOrArms is either a single
 *   Mode or an array of arm modes; realtime is "involved" if any equals
 *   'realtime'. `targetCantoOnRealtime` fires ONLY when the target language
 *   is Cantonese (langIdx 1, not reversed) and realtime is involved;
 *   `inputCantoOnRealtime` fires ONLY when the source is Cantonese
 *   (langIdx 1, reversed) and realtime is involved.
 */

import type { Mode } from '../../core/timing';

export type SessionStatus =
  | 'idle'
  | 'requesting-permission'
  | 'permission-denied'
  | 'listening'
  | 'processing'
  | 'ready'
  | 'playing'
  | 'reconnecting'
  | 'disconnected'
  | 'stopping'
  | 'stopped';

export type MicPermission = 'not-requested' | 'requesting' | 'granted' | 'denied';

export type SwitchKind = 'mode' | 'language' | 'direction';

/** Partial settings patch applied at the next utterance boundary. */
export interface SwitchPatch {
  mode?: Mode;
  langIdx?: number;
  reversed?: boolean;
}

/** The "switch queued" overlay — carried alongside an active status. */
export interface PendingSwitch {
  kind: SwitchKind;
  /** Human-readable label for the queued-switch chip, e.g. 'Realtime'. */
  label: string;
  patch: SwitchPatch;
}

/** Final session summary attached at FLUSH_DONE. */
export interface SessionSummary {
  elapsedMs: number;
  utterances: number;
  dropped: number;
  costUsd: number;
}

export interface SessionState {
  status: SessionStatus;
  micPermission: MicPermission;
  mode: Mode;
  /** Index into `pairs`: 0 = EN↔ES, 1 = EN↔YUE. */
  langIdx: number;
  /** false = pairs[langIdx].src → tgt; true = tgt → src. */
  reversed: boolean;
  /** Active arm ids, max 3. */
  arms: string[];
  autoplay: boolean;
  pending: PendingSwitch | null;
  reconnectAttempts: number;
  /** Status to resume after a successful reconnect; null outside a drop. */
  resumeStatus: SessionStatus | null;
  /** Arm whose audio is currently playing; null outside 'playing'. */
  playingArm: string | null;
  /** Transcript-preservation marker — must survive reconnect cycles. */
  utteranceCount: number;
  startedAt: number | null;
  stoppedAt: number | null;
  summary: SessionSummary | null;
}

/** Event shapes — see the design doc-comment above. */
export type SessionEvent =
  | { type: 'START'; now: number }
  | { type: 'PERMISSION_GRANTED' }
  | { type: 'PERMISSION_DENIED' }
  | { type: 'SPEECH_DETECTED' }
  | { type: 'ARMS_SETTLED' }
  | { type: 'PLAY'; armId: string }
  | { type: 'PLAYBACK_ENDED' }
  | { type: 'REQUEST_SWITCH'; kind: SwitchKind; label: string; patch: SwitchPatch }
  | { type: 'UTTERANCE_BOUNDARY' }
  | { type: 'CONNECTION_LOST' }
  | { type: 'RECONNECT_ATTEMPT' }
  | { type: 'RECONNECTED' }
  | { type: 'RECONNECT_EXHAUSTED' }
  | { type: 'RECONNECT_CLICKED' }
  | { type: 'STOP'; now: number }
  | { type: 'FLUSH_DONE'; summary: SessionSummary }
  | { type: 'NEW_SESSION'; now: number }
  | { type: 'ADD_ARM'; armId: string }
  | { type: 'REMOVE_ARM'; armId: string }
  | { type: 'SET_AUTOPLAY'; value: boolean };

export const MAX_RECONNECT_ATTEMPTS = 5;

export interface LanguagePairDef {
  src: string;
  tgt: string;
}

/** Supported language pairs; index is `langIdx`. */
export const pairs: readonly LanguagePairDef[] = [
  { src: 'English', tgt: 'Spanish' },
  { src: 'English', tgt: 'Cantonese' },
];

export function createInitialState(overrides?: Partial<SessionState>): SessionState {
  void overrides;
  throw new Error('not implemented');
}

export function reduce(state: SessionState, event: SessionEvent): SessionState {
  void state;
  void event;
  throw new Error('not implemented');
}

export function supportPill(langIdx: number): 'both modes' | 'cascade only' {
  void langIdx;
  throw new Error('not implemented');
}

export interface LanguageWarnings {
  targetCantoOnRealtime: boolean;
  inputCantoOnRealtime: boolean;
}

export function warnings(
  langIdx: number,
  reversed: boolean,
  modeOrArms: Mode | readonly Mode[],
): LanguageWarnings {
  void langIdx;
  void reversed;
  void modeOrArms;
  throw new Error('not implemented');
}
