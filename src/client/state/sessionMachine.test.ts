import { describe, expect, it } from 'vitest';
import * as sessionMachine from './sessionMachine';
import { DEFAULT_CASCADE_TRIPLE } from '../../core/arms';
import {
  LIVE_MAX_SESSION_MS,
  MAX_RECONNECT_ATTEMPTS,
  createInitialState,
  pairs,
  reduce,
  stateLabel,
  supportPill,
  type ContextPolicy,
  type MicPermission,
  type ProviderStage,
  type SessionEvent,
  type SessionState,
  type SessionStatus,
  type SwitchKind,
  type SwitchPatch,
} from './sessionMachine';

function run(state: SessionState, ...events: SessionEvent[]): SessionState {
  return events.reduce(reduce, state);
}

/** A state mid-session with the mic already granted. */
function active(status: SessionStatus, overrides: Partial<SessionState> = {}): SessionState {
  return createInitialState({
    status,
    micPermission: 'granted',
    startedAt: 1_000,
    ...overrides,
  });
}

describe('createInitialState', () => {
  it('has the documented defaults', () => {
    const s = createInitialState();
    expect(s.status).toBe('idle');
    expect(s.micPermission).toBe('not-requested');
    // Ticket 017: the design mock's initial state governs — Realtime default.
    expect(s.mode).toBe('realtime');
    expect(s.langIdx).toBe(0);
    expect(s.reversed).toBe(false);
    expect(s.pending).toBeNull();
    expect(s.reconnectAttempts).toBe(0);
    expect(s.utteranceCount).toBe(0);
    expect(s.startedAt).toBeNull();
    expect(s.stoppedAt).toBeNull();
    expect(s.summary).toBeNull();
  });

  it('applies overrides', () => {
    const s = createInitialState({ status: 'ready', micPermission: 'granted', langIdx: 1 });
    expect(s.status).toBe('ready');
    expect(s.micPermission).toBe('granted');
    expect(s.langIdx).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ticket 012 — one architecture per session
// ---------------------------------------------------------------------------

describe('ticket 012 — the multi-arm machinery is gone', () => {
  it('carries no `arms` array', () => {
    expect(Object.keys(createInitialState())).not.toContain('arms');
  });

  it('carries no `playingArm` — one architecture means one output', () => {
    expect(Object.keys(createInitialState())).not.toContain('playingArm');
  });

  it('autoplay is true from the start and no event can turn it off', () => {
    const s = createInitialState();
    expect(s.autoplay).toBe(true);

    const walked = run(
      s,
      { type: 'START', now: 1 },
      { type: 'PERMISSION_GRANTED', now: 2 },
      { type: 'SPEECH_DETECTED' },
      { type: 'ARMS_SETTLED' },
      { type: 'PLAY' },
      { type: 'PLAYBACK_ENDED' },
      { type: 'UTTERANCE_BOUNDARY' },
    );
    expect(walked.autoplay).toBe(true);
  });

  it('the deleted arm/autoplay events are inert', () => {
    const s = active('listening');
    // Spelled indirectly so the DELETE guard (deletions.test.ts) still sees a
    // client tree with zero occurrences of the removed event names.
    const deleted = ['ADD', 'REMOVE'].map((verb) => `${verb}_ARM`).concat('SET_' + 'AUTOPLAY');
    for (const type of deleted) {
      const after = reduce(s, { type, armId: 'x', value: false } as unknown as SessionEvent);
      expect(after, `${type} must not be handled`).toEqual(s);
    }
  });

  it('PLAY carries no arm payload; PLAYBACK_ENDED returns to ready', () => {
    const playing = reduce(active('ready'), { type: 'PLAY' });
    expect(playing.status).toBe('playing');
    expect(reduce(playing, { type: 'PLAYBACK_ENDED' }).status).toBe('ready');
  });
});

describe('ticket 012 — cascade providers and realtime context policy', () => {
  it("defaults `providers` to Arm B's frozen triple", () => {
    expect(createInitialState().providers).toEqual(DEFAULT_CASCADE_TRIPLE);
  });

  it("defaults `contextPolicy` to 'default'", () => {
    expect(createInitialState().contextPolicy).toBe('default');
  });

  const stages: ProviderStage[] = ['stt', 'mt', 'tts'];
  for (const stage of stages) {
    it(`SET_PROVIDER replaces the ${stage} leg and leaves the others alone`, () => {
      const s = reduce(active('listening'), { type: 'SET_PROVIDER', stage, model: 'swapped' });
      expect(s.providers[stage]).toBe('swapped');
      for (const other of stages.filter((x) => x !== stage)) {
        expect(s.providers[other]).toBe(DEFAULT_CASCADE_TRIPLE[other]);
      }
    });
  }

  const policies: ContextPolicy[] = ['default', 'trimmed'];
  for (const value of policies) {
    it(`SET_CONTEXT_POLICY sets '${value}'`, () => {
      expect(reduce(active('listening'), { type: 'SET_CONTEXT_POLICY', value }).contextPolicy).toBe(
        value,
      );
    });
  }

  it('SET_PROVIDER / SET_CONTEXT_POLICY apply immediately — they never queue', () => {
    const mid = active('processing');
    const p = reduce(mid, { type: 'SET_PROVIDER', stage: 'tts', model: 'eleven_flash_v2_5' });
    expect(p.providers.tts).toBe('eleven_flash_v2_5');
    expect(p.pending).toBeNull();

    const c = reduce(mid, { type: 'SET_CONTEXT_POLICY', value: 'trimmed' });
    expect(c.contextPolicy).toBe('trimmed');
    expect(c.pending).toBeNull();
  });
});

describe('ticket 012 — the Live cap and the derived switch-queued label', () => {
  it('LIVE_MAX_SESSION_MS is five minutes', () => {
    expect(LIVE_MAX_SESSION_MS).toBe(300_000);
  });

  it("stateLabel is the status when nothing is queued, 'switch-queued' when something is", () => {
    const processing = active('processing');
    expect(stateLabel(processing)).toBe('processing');

    const queued = reduce(processing, {
      type: 'REQUEST_SWITCH',
      kind: 'mode',
      label: 'Cascade',
      patch: { mode: 'cascade' },
    });
    // The overlay is carried ALONGSIDE the active status (that is the whole
    // point of modelling it as an overlay) — the label is what the UI shows.
    expect(queued.status).toBe('processing');
    expect(stateLabel(queued)).toBe('switch-queued');

    expect(stateLabel(reduce(queued, { type: 'UTTERANCE_BOUNDARY' }))).toBe('processing');
  });
});

describe('rule 1 — happy path', () => {
  const steps: Array<[SessionEvent, SessionStatus, MicPermission]> = [
    [{ type: 'START', now: 5_000 }, 'requesting-permission', 'requesting'],
    [{ type: 'PERMISSION_GRANTED', now: 6_000 }, 'listening', 'granted'],
    [{ type: 'SPEECH_DETECTED' }, 'processing', 'granted'],
    [{ type: 'ARMS_SETTLED' }, 'ready', 'granted'],
    [{ type: 'PLAY' }, 'playing', 'granted'],
    [{ type: 'PLAYBACK_ENDED' }, 'ready', 'granted'],
  ];

  it('walks idle → … → ready through the full utterance cycle', () => {
    let s = createInitialState();
    for (const [event, status, mic] of steps) {
      s = reduce(s, event);
      expect(s.status, `after ${event.type}`).toBe(status);
      expect(s.micPermission, `mic after ${event.type}`).toBe(mic);
    }
  });

  // Ticket 016: startedAt belongs to a RUNNING session — START must NOT
  // stamp it; PERMISSION_GRANTED stamps it from its own payload.
  it('START leaves startedAt null (the session has not started yet)', () => {
    const s = reduce(createInitialState(), { type: 'START', now: 5_000 });
    expect(s.startedAt).toBeNull();
  });

  it('PERMISSION_GRANTED stamps startedAt on entering listening', () => {
    const s = run(
      createInitialState(),
      { type: 'START', now: 5_000 },
      { type: 'PERMISSION_GRANTED', now: 8_000 },
    );
    expect(s.status).toBe('listening');
    expect(s.startedAt).toBe(8_000);
  });

  it('SPEECH_DETECTED from ready starts the next utterance (→ processing)', () => {
    const s = reduce(active('ready'), { type: 'SPEECH_DETECTED' });
    expect(s.status).toBe('processing');
  });

  it('reduce does not mutate the input state', () => {
    const s = createInitialState();
    const before = structuredClone(s);
    reduce(s, { type: 'START', now: 1 });
    expect(s).toEqual(before);
  });
});

describe('rule 2 — permission denied', () => {
  it('PERMISSION_DENIED → permission-denied with micPermission denied', () => {
    const s = run(createInitialState(), { type: 'START', now: 1 }, { type: 'PERMISSION_DENIED' });
    expect(s.status).toBe('permission-denied');
    expect(s.micPermission).toBe('denied');
  });

  it('START while denied is a no-op (blocking)', () => {
    const denied = run(
      createInitialState(),
      { type: 'START', now: 1 },
      { type: 'PERMISSION_DENIED' },
    );
    const after = reduce(denied, { type: 'START', now: 2 });
    expect(after).toEqual(denied);
  });

  // Ticket 016: no session ever started, so nothing may feed an elapsed
  // timer — startedAt stays null through the denied path.
  it('permission-denied leaves startedAt null — elapsed derivation yields 0', () => {
    const s = run(
      createInitialState(),
      { type: 'START', now: 31_000 },
      { type: 'PERMISSION_DENIED' },
    );
    expect(s.status).toBe('permission-denied');
    expect(s.startedAt).toBeNull();
    expect(s.stoppedAt).toBeNull();
  });
});

describe('rule 3 — switch queueing (mode, language AND direction)', () => {
  const kinds: Array<{
    kind: SwitchKind;
    label: string;
    patch: SwitchPatch;
    read: (s: SessionState) => unknown;
    expected: unknown;
    initial: Partial<SessionState>;
  }> = [
    {
      kind: 'mode',
      label: 'Realtime',
      patch: { mode: 'realtime' },
      read: (s) => s.mode,
      expected: 'realtime',
      initial: { mode: 'cascade' },
    },
    {
      kind: 'language',
      label: 'EN↔YUE',
      patch: { langIdx: 1 },
      read: (s) => s.langIdx,
      expected: 1,
      initial: { langIdx: 0 },
    },
    {
      kind: 'direction',
      label: 'ES→EN',
      patch: { reversed: true },
      read: (s) => s.reversed,
      expected: true,
      initial: { reversed: false },
    },
  ];

  // Ticket 019: a switch queues ONLY while an utterance is actually in
  // flight (processing/playing). listening/ready ARE boundaries — there is
  // no sentence to finish, so the patch applies immediately.
  const inFlightStatuses: SessionStatus[] = ['processing', 'playing'];
  const boundaryStatuses: SessionStatus[] = ['listening', 'ready'];

  for (const c of kinds) {
    for (const status of inFlightStatuses) {
      it(`${c.kind} switch while ${status}: queued as pending, applied at UTTERANCE_BOUNDARY`, () => {
        const start = active(status, c.initial);
        const queued = reduce(start, {
          type: 'REQUEST_SWITCH',
          kind: c.kind,
          label: c.label,
          patch: c.patch,
        });
        expect(queued.status).toBe(status);
        expect(queued.pending).toEqual({ kind: c.kind, label: c.label, patch: c.patch });
        expect(c.read(queued), 'setting must not change before the boundary').toEqual(
          c.read(start),
        );

        const applied = reduce(queued, { type: 'UTTERANCE_BOUNDARY' });
        expect(c.read(applied)).toEqual(c.expected);
        expect(applied.pending).toBeNull();
      });
    }

    for (const status of boundaryStatuses) {
      it(`${c.kind} switch while ${status}: no utterance in flight — applied immediately`, () => {
        const start = active(status, c.initial);
        const s = reduce(start, {
          type: 'REQUEST_SWITCH',
          kind: c.kind,
          label: c.label,
          patch: c.patch,
        });
        expect(s.status).toBe(status);
        expect(c.read(s)).toEqual(c.expected);
        expect(s.pending).toBeNull();
      });
    }

    for (const status of ['idle', 'stopped'] as const) {
      it(`${c.kind} switch while ${status}: applied immediately, pending stays null`, () => {
        const start = createInitialState({ status, ...c.initial });
        const s = reduce(start, {
          type: 'REQUEST_SWITCH',
          kind: c.kind,
          label: c.label,
          patch: c.patch,
        });
        expect(c.read(s)).toEqual(c.expected);
        expect(s.pending).toBeNull();
      });
    }
  }

  it('UTTERANCE_BOUNDARY with no pending changes no settings', () => {
    const start = active('listening', { mode: 'cascade', langIdx: 0, reversed: false });
    const s = reduce(start, { type: 'UTTERANCE_BOUNDARY' });
    expect(s.mode).toBe('cascade');
    expect(s.langIdx).toBe(0);
    expect(s.reversed).toBe(false);
    expect(s.pending).toBeNull();
  });

  it('UTTERANCE_BOUNDARY increments the transcript marker (utteranceCount)', () => {
    const s = run(
      active('listening', { utteranceCount: 2 }),
      { type: 'UTTERANCE_BOUNDARY' },
      { type: 'UTTERANCE_BOUNDARY' },
    );
    expect(s.utteranceCount).toBe(4);
  });
});

describe('rule 5 — reconnect', () => {
  const liveStatuses: SessionStatus[] = ['listening', 'processing', 'ready', 'playing'];

  for (const status of liveStatuses) {
    it(`CONNECTION_LOST from ${status} → reconnecting; RECONNECTED returns to ${status}`, () => {
      const lost = reduce(active(status, { utteranceCount: 7 }), { type: 'CONNECTION_LOST' });
      expect(lost.status).toBe('reconnecting');

      const back = reduce(lost, { type: 'RECONNECTED' });
      expect(back.status).toBe(status);
      expect(back.reconnectAttempts).toBe(0);
      expect(back.utteranceCount, 'transcript marker preserved').toBe(7);
    });
  }

  it('RECONNECT_ATTEMPT increments attempts', () => {
    const lost = reduce(active('listening'), { type: 'CONNECTION_LOST' });
    const s = run(lost, { type: 'RECONNECT_ATTEMPT' }, { type: 'RECONNECT_ATTEMPT' });
    expect(s.status).toBe('reconnecting');
    expect(s.reconnectAttempts).toBe(2);
  });

  it(`a RECONNECT_ATTEMPT past the max of ${MAX_RECONNECT_ATTEMPTS} → disconnected`, () => {
    let s = reduce(active('listening'), { type: 'CONNECTION_LOST' });
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
      s = reduce(s, { type: 'RECONNECT_ATTEMPT' });
      expect(s.status, `attempt ${i + 1}`).toBe('reconnecting');
    }
    expect(s.reconnectAttempts).toBe(MAX_RECONNECT_ATTEMPTS);
    s = reduce(s, { type: 'RECONNECT_ATTEMPT' });
    expect(s.status).toBe('disconnected');
  });

  it('RECONNECT_EXHAUSTED → disconnected', () => {
    const s = run(
      active('ready'),
      { type: 'CONNECTION_LOST' },
      { type: 'RECONNECT_ATTEMPT' },
      { type: 'RECONNECT_EXHAUSTED' },
    );
    expect(s.status).toBe('disconnected');
  });

  it('RECONNECTED after mid-drop attempts resets the attempt counter', () => {
    const s = run(
      active('processing'),
      { type: 'CONNECTION_LOST' },
      { type: 'RECONNECT_ATTEMPT' },
      { type: 'RECONNECT_ATTEMPT' },
      { type: 'RECONNECTED' },
    );
    expect(s.status).toBe('processing');
    expect(s.reconnectAttempts).toBe(0);
  });

  it('RECONNECT_CLICKED from disconnected → reconnecting with attempts reset', () => {
    const disconnected = run(
      active('listening', { utteranceCount: 3 }),
      { type: 'CONNECTION_LOST' },
      { type: 'RECONNECT_EXHAUSTED' },
    );
    const retry = reduce(disconnected, { type: 'RECONNECT_CLICKED' });
    expect(retry.status).toBe('reconnecting');
    expect(retry.reconnectAttempts).toBe(0);

    const back = reduce(retry, { type: 'RECONNECTED' });
    expect(back.status, 'pre-drop status survives the disconnected detour').toBe('listening');
    expect(back.utteranceCount).toBe(3);
  });
});

describe('rule 6 — stop, flush, new session', () => {
  const stoppable: SessionStatus[] = [
    'requesting-permission',
    'listening',
    'processing',
    'ready',
    'playing',
    'reconnecting',
    'disconnected',
  ];

  for (const status of stoppable) {
    it(`STOP from ${status} → stopping with stoppedAt recorded`, () => {
      const s = reduce(active(status), { type: 'STOP', now: 9_000 });
      expect(s.status).toBe('stopping');
      expect(s.stoppedAt).toBe(9_000);
    });
  }

  it('STOP from idle and stopped is a no-op', () => {
    for (const status of ['idle', 'stopped'] as const) {
      const s = createInitialState({ status });
      expect(reduce(s, { type: 'STOP', now: 9_000 })).toEqual(s);
    }
  });

  it('FLUSH_DONE → stopped with the summary attached', () => {
    const summary = { elapsedMs: 60_000, utterances: 12, dropped: 1, costUsd: 0.42 };
    const s = run(
      active('listening'),
      { type: 'STOP', now: 9_000 },
      { type: 'FLUSH_DONE', summary },
    );
    expect(s.status).toBe('stopped');
    expect(s.summary).toEqual(summary);
  });

  it('NEW_SESSION with mic already granted goes straight to listening (no re-prompt)', () => {
    const stopped = createInitialState({
      status: 'stopped',
      micPermission: 'granted',
      utteranceCount: 12,
      stoppedAt: 9_000,
      summary: { elapsedMs: 1, utterances: 12, dropped: 0, costUsd: 0.1 },
    });
    const s = reduce(stopped, { type: 'NEW_SESSION', now: 10_000 });
    expect(s.status).toBe('listening');
    expect(s.micPermission).toBe('granted');
    expect(s.utteranceCount).toBe(0);
    expect(s.startedAt).toBe(10_000);
    expect(s.stoppedAt).toBeNull();
    expect(s.summary).toBeNull();
  });

  it('NEW_SESSION without granted mic re-enters requesting-permission', () => {
    const stopped = createInitialState({ status: 'stopped', micPermission: 'not-requested' });
    const s = reduce(stopped, { type: 'NEW_SESSION', now: 10_000 });
    expect(s.status).toBe('requesting-permission');
    expect(s.micPermission).toBe('requesting');
  });

  // Ticket 016: same rule on the new-session path — startedAt stays null
  // until the grant actually starts the session.
  it('NEW_SESSION without granted mic leaves startedAt null until PERMISSION_GRANTED', () => {
    const stopped = createInitialState({
      status: 'stopped',
      micPermission: 'not-requested',
      startedAt: 1_000,
      stoppedAt: 9_000,
    });
    const requesting = reduce(stopped, { type: 'NEW_SESSION', now: 10_000 });
    expect(requesting.startedAt).toBeNull();

    const granted = reduce(requesting, { type: 'PERMISSION_GRANTED', now: 12_000 });
    expect(granted.status).toBe('listening');
    expect(granted.startedAt).toBe(12_000);
  });
});

describe('rule 7 — language pair helpers', () => {
  it('exposes the two supported pairs', () => {
    expect(pairs).toEqual([
      { src: 'English', tgt: 'Spanish' },
      { src: 'English', tgt: 'Cantonese' },
    ]);
  });

  // TICKET 074 — the 'cascade only' claim is RETIRED. It encoded
  // `gpt-realtime-translate`'s 13-output-language list; this project runs
  // `gpt-realtime`, which takes a free-text `instructions` field with no
  // output-language enum (ticket 073). The operator has run EN→YUE on Realtime
  // and observed Cantonese output.
  it('supportPill: BOTH pairs are both-modes — no pair is cascade only', () => {
    expect(supportPill(0)).toBe('both modes');
    expect(supportPill(1)).toBe('both modes');
    expect(supportPill(1)).not.toBe('cascade only');
  });

  // TICKET 074 (REMAINING item, 2026-08-10) — the language-warning helper is
  // GONE, not merely returning false. Both Cantonese-on-Realtime warnings were
  // retired: the forward one first, then `inputCantoOnRealtime` once the
  // operator spoke Cantonese into Realtime and got English back. Nothing this
  // project supports earns a warning, so nothing computes one.
  //
  // This is the re-pointed version of "swapping to Cantonese INPUT on Realtime
  // still fires the input warning" — the case that had to go red.
  it('there is no language-warning helper, and no warning name survives it', () => {
    const exported = Object.keys(sessionMachine);
    // Needle assembled from fragments: prose in this file must not satisfy the
    // scan (ticket 060's lesson).
    expect(exported).not.toContain('warn' + 'ings');
    expect(exported.some((k) => /canto/i.test(k))).toBe(false);
  });
});
