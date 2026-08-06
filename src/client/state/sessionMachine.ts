/**
 * Ticket 008 / 012 — Session lifecycle state machine + four-value mic
 * permission. Live is ONE architecture per session (PRD §17 19g); the
 * multi-arm machinery was deleted in ticket 012.
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
 *   `stateLabel(state)` derives the PRD's visible 'switch-queued' label from
 *   the overlay so the UI can show it without the machine growing a state.
 * - `micPermission` is a SEPARATE four-value field ('not-requested' |
 *   'requesting' | 'granted' | 'denied') — never a boolean.
 * - ONE ARCHITECTURE: no `arms`, no ADD_ARM/REMOVE_ARM, no autoplay
 *   invariants. Live autoplay is on unconditionally.
 * - Cascade per-stage selection lives in `providers` (defaulting to Arm B's
 *   frozen triple) and realtime context policy in `contextPolicy`.
 * - Happy path: idle →START→ requesting-permission (mic 'requesting')
 *   →PERMISSION_GRANTED→ listening (mic 'granted') →SPEECH_DETECTED→
 *   processing →ARMS_SETTLED→ ready →PLAY→ playing →PLAYBACK_ENDED→ ready.
 * - TICKET 016 (elapsed belongs to a RUNNING session): `startedAt` stays
 *   null through requesting-permission and permission-denied — START does
 *   NOT stamp it. PERMISSION_GRANTED carries `now` and stamps `startedAt`
 *   on entering 'listening'. Same rule for NEW_SESSION: it stamps
 *   `startedAt` only when the mic is already granted (straight to
 *   listening); otherwise startedAt stays null until PERMISSION_GRANTED.
 *   Elapsed derivation is therefore `startedAt === null ? 0 : (stoppedAt ??
 *   now) - startedAt` — permission-denied always shows 00:00.
 * - SPEECH_DETECTED is accepted from both 'listening' and 'ready' (the next
 *   utterance can begin while the previous result is on screen).
 * - PLAY carries no payload (there is one architecture, so one output);
 *   PLAYBACK_ENDED returns to 'ready'. PLAY is only meaningful from 'ready'.
 * - PERMISSION_DENIED → 'permission-denied' + micPermission 'denied'; START
 *   while micPermission is 'denied' is a no-op (blocking screen).
 * - REQUEST_SWITCH(kind, label, patch) — TICKET 019: queues ONLY while an
 *   utterance is actually in flight (status 'processing' | 'playing'):
 *   there it sets `pending`, and UTTERANCE_BOUNDARY applies the patch
 *   (mode / langIdx / reversed) and clears `pending`. In every other status
 *   — including 'listening' and 'ready' (a boundary: no sentence to finish)
 *   and idle/stopped — the patch applies immediately and `pending` stays
 *   null. Same mechanism for all three kinds ('mode' | 'language' |
 *   'direction').
 * - UTTERANCE_BOUNDARY also increments `utteranceCount` — the transcript
 *   preservation marker that must survive reconnect cycles.
 * - SET_PROVIDER({stage, model}) replaces one leg of the cascade triple;
 *   SET_CONTEXT_POLICY({value}) sets the realtime context policy. Both apply
 *   immediately — only mode / language / direction queue at a boundary.
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
 *   and sets startedAt = now.
 * - Defaults (createInitialState): status 'idle', micPermission
 *   'not-requested', mode 'realtime' (TICKET 017 — the design mock's
 *   initial state governs; was 'cascade'), langIdx 0 (EN↔ES), reversed
 *   false, providers DEFAULT_CASCADE_TRIPLE (Arm B's frozen recipe),
 *   contextPolicy 'default', autoplay true, pending null,
 *   reconnectAttempts 0, resumeStatus null, utteranceCount 0,
 *   startedAt/stoppedAt null, summary null. Accepts a Partial override for
 *   test setup.
 * - `reduce` never mutates its input state.
 * - LIVE_MAX_SESSION_MS (5 minutes) is the Live cap; the controller stops
 *   the session when elapsed reaches it.
 *
 * Language/direction helpers (rule group 7) live in this file:
 * - `pairs`: [{src:'English', tgt:'Spanish'}, {src:'English', tgt:'Cantonese'}]
 * - `supportPill(langIdx)`: 'both modes' for EN↔ES, 'cascade only' for the
 *   Cantonese pair.
 * - `warnings(langIdx, reversed, mode)`: `targetCantoOnRealtime` fires ONLY
 *   when the target language is Cantonese (langIdx 1, not reversed) and the
 *   mode is realtime; `inputCantoOnRealtime` fires ONLY when the source is
 *   Cantonese (langIdx 1, reversed) and the mode is realtime.
 */

import { DEFAULT_CASCADE_TRIPLE, type ProviderTriple } from '../../core/arms';
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

/** Realtime-only, Live-only conversation-context policy (PRD §5). */
export type ContextPolicy = 'default' | 'trimmed';

/** The three cascade legs a per-stage selector can change. */
export type ProviderStage = 'stt' | 'mt' | 'tts';

/** The Live cap: a session ends at five minutes (PRD §7). */
export const LIVE_MAX_SESSION_MS = 300_000;

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
  /** Cascade per-stage model selection. Defaults to Arm B's frozen triple. */
  providers: ProviderTriple;
  /** Realtime-only context policy. */
  contextPolicy: ContextPolicy;
  /** Live autoplay is on unconditionally — one architecture collides with nothing. */
  autoplay: boolean;
  pending: PendingSwitch | null;
  reconnectAttempts: number;
  /** Status to resume after a successful reconnect; null outside a drop. */
  resumeStatus: SessionStatus | null;
  /** Transcript-preservation marker — must survive reconnect cycles. */
  utteranceCount: number;
  startedAt: number | null;
  stoppedAt: number | null;
  summary: SessionSummary | null;
}

/** Event shapes — see the design doc-comment above. */
export type SessionEvent =
  | { type: 'START'; now: number }
  /** Carries `now` — startedAt is stamped HERE, not at START (ticket 016). */
  | { type: 'PERMISSION_GRANTED'; now: number }
  | { type: 'PERMISSION_DENIED' }
  | { type: 'SPEECH_DETECTED' }
  | { type: 'ARMS_SETTLED' }
  | { type: 'PLAY' }
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
  | { type: 'SET_PROVIDER'; stage: ProviderStage; model: string }
  | { type: 'SET_CONTEXT_POLICY'; value: ContextPolicy };

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
  return {
    status: 'idle',
    micPermission: 'not-requested',
    // Ticket 017: the design mock's initial state governs — Realtime default,
    // seeded with the realtime catalog arm id.
    mode: 'realtime',
    langIdx: 0,
    reversed: false,
    // Arm B's frozen recipe: a default that derived to 'ad-hoc' would quietly
    // turn every unconfigured cascade session into an orphan (PRD §17 23d).
    providers: { ...DEFAULT_CASCADE_TRIPLE },
    contextPolicy: 'default',
    autoplay: true,
    pending: null,
    reconnectAttempts: 0,
    resumeStatus: null,
    utteranceCount: 0,
    startedAt: null,
    stoppedAt: null,
    summary: null,
    ...overrides,
  };
}

const ACTIVE_STATUSES: readonly SessionStatus[] = ['listening', 'processing', 'ready', 'playing'];

const STOPPABLE_STATUSES: readonly SessionStatus[] = [
  'requesting-permission',
  'listening',
  'processing',
  'ready',
  'playing',
  'reconnecting',
  'disconnected',
];

export function reduce(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'START': {
      if (state.status !== 'idle' || state.micPermission === 'denied') return state;
      // Ticket 016: startedAt is NOT stamped here — the session has not
      // started yet (permission-denied must show a non-advancing 00:00).
      return {
        ...state,
        status: 'requesting-permission',
        micPermission: 'requesting',
      };
    }

    case 'PERMISSION_GRANTED': {
      if (state.status !== 'requesting-permission') return state;
      // Ticket 016: the session starts HERE — stamp startedAt on entering
      // 'listening' from the event's own clock payload.
      return { ...state, status: 'listening', micPermission: 'granted', startedAt: event.now };
    }

    case 'PERMISSION_DENIED': {
      if (state.status !== 'requesting-permission') return state;
      return { ...state, status: 'permission-denied', micPermission: 'denied' };
    }

    case 'SPEECH_DETECTED': {
      if (state.status !== 'listening' && state.status !== 'ready') return state;
      return { ...state, status: 'processing' };
    }

    case 'ARMS_SETTLED': {
      if (state.status !== 'processing') return state;
      return { ...state, status: 'ready' };
    }

    case 'PLAY': {
      if (state.status !== 'ready') return state;
      return { ...state, status: 'playing' };
    }

    case 'PLAYBACK_ENDED': {
      if (state.status !== 'playing') return state;
      return { ...state, status: 'ready' };
    }

    case 'REQUEST_SWITCH': {
      // Ticket 019: queue ONLY while an utterance is actually in flight
      // (processing/playing). listening/ready ARE boundaries — no sentence
      // to finish — so the patch applies immediately, like idle/stopped.
      if (state.status === 'processing' || state.status === 'playing') {
        return {
          ...state,
          pending: { kind: event.kind, label: event.label, patch: { ...event.patch } },
        };
      }
      return { ...state, ...event.patch, pending: null };
    }

    case 'UTTERANCE_BOUNDARY': {
      const next: SessionState = {
        ...state,
        ...(state.pending ? state.pending.patch : {}),
        pending: null,
        utteranceCount: state.utteranceCount + 1,
      };
      return next;
    }

    case 'SET_PROVIDER': {
      // Per-stage selection applies IMMEDIATELY — only mode / language /
      // direction are boundary-queued, and `pending` is left untouched.
      return { ...state, providers: { ...state.providers, [event.stage]: event.model } };
    }

    case 'SET_CONTEXT_POLICY': {
      return { ...state, contextPolicy: event.value };
    }

    case 'CONNECTION_LOST': {
      if (!ACTIVE_STATUSES.includes(state.status)) return state;
      return { ...state, status: 'reconnecting', resumeStatus: state.status };
    }

    case 'RECONNECT_ATTEMPT': {
      if (state.status !== 'reconnecting') return state;
      if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        return { ...state, status: 'disconnected' };
      }
      return { ...state, reconnectAttempts: state.reconnectAttempts + 1 };
    }

    case 'RECONNECT_EXHAUSTED': {
      if (state.status !== 'reconnecting') return state;
      return { ...state, status: 'disconnected' };
    }

    case 'RECONNECTED': {
      if (state.status !== 'reconnecting') return state;
      return {
        ...state,
        status: state.resumeStatus ?? 'listening',
        resumeStatus: null,
        reconnectAttempts: 0,
      };
    }

    case 'RECONNECT_CLICKED': {
      if (state.status !== 'disconnected') return state;
      return { ...state, status: 'reconnecting', reconnectAttempts: 0 };
    }

    case 'STOP': {
      if (!STOPPABLE_STATUSES.includes(state.status)) return state;
      return { ...state, status: 'stopping', stoppedAt: event.now };
    }

    case 'FLUSH_DONE': {
      if (state.status !== 'stopping') return state;
      return { ...state, status: 'stopped', summary: { ...event.summary } };
    }

    case 'NEW_SESSION': {
      const granted = state.micPermission === 'granted';
      return {
        ...state,
        status: granted ? 'listening' : 'requesting-permission',
        micPermission: granted ? 'granted' : 'requesting',
        pending: null,
        reconnectAttempts: 0,
        resumeStatus: null,
        utteranceCount: 0,
        // Ticket 016: only a session that actually starts (straight to
        // listening) gets a startedAt; otherwise it stays null until
        // PERMISSION_GRANTED stamps it.
        startedAt: granted ? event.now : null,
        stoppedAt: null,
        summary: null,
      };
    }

    default:
      return state;
  }
}

export function supportPill(langIdx: number): 'both modes' | 'cascade only' {
  return langIdx === 1 ? 'cascade only' : 'both modes';
}

/**
 * The PRD §7 visible state label. `switch-queued` is modelled as the
 * `pending` OVERLAY (strictly more expressive: you can be 'processing' AND
 * have a switch queued), so the label is derived here rather than added to
 * the status union.
 */
export function stateLabel(state: SessionState): string {
  return state.pending ? 'switch-queued' : state.status;
}

export interface LanguageWarnings {
  targetCantoOnRealtime: boolean;
  inputCantoOnRealtime: boolean;
}

export function warnings(langIdx: number, reversed: boolean, mode: Mode): LanguageWarnings {
  const realtimeInvolved = mode === 'realtime';
  const cantoPair = langIdx === 1;
  return {
    targetCantoOnRealtime: cantoPair && !reversed && realtimeInvolved,
    inputCantoOnRealtime: cantoPair && reversed && realtimeInvolved,
  };
}
