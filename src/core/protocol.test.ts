import { describe, expect, it } from 'vitest';
import {
  SAMPLE_RATE,
  TTS_FRAME_HEADER_BYTES,
  decodeTtsFrame,
  encodeTtsFrame,
} from './protocol';
import type { ClientToServerMessage, ServerToClientMessage } from './protocol';
import type { UtteranceRecord } from './timing';

describe('cascade wire protocol', () => {
  it('SAMPLE_RATE is 24000', () => {
    expect(SAMPLE_RATE).toBe(24000);
  });

  it('message unions typecheck (compile-time shape lock)', () => {
    const record: UtteranceRecord = {
      id: 'u1',
      arm: 'a',
      mode: 'cascade',
      languagePair: 'en-es',
      direction: 'en->es',
      sourcePartials: [],
      sourceFinal: 'hello world',
      targetPartials: [],
      targetFinal: 'hola mundo',
      audioState: 'played',
      audioDurationMs: 100,
      timings: {},
      speechEndSource: 'vad',
      providers: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
      costUnits: 0,
      corpusId: 'c1',
      runId: 'r1',
    };

    // Audio is NOT JSON any more — no audio.chunk / tts.chunk members.
    const up = [
      {
        type: 'session.start',
        mode: 'cascade',
        languagePair: 'en-es',
        direction: 'en->es',
        providers: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
      },
      { type: 'session.end' },
    ] satisfies ClientToServerMessage[];

    const down = [
      { type: 'stt.partial', utt: 0, text: 'hel' },
      { type: 'stt.final', utt: 0, text: 'hello' },
      { type: 'mt.delta', utt: 0, text: 'ho' },
      { type: 'mt.final', utt: 0, text: 'hola' },
      { type: 'stage.timing', utt: 0, stage: 'stt', event: 'first_yield', t: 123 },
      { type: 'utterance.complete', utt: 0, record },
      { type: 'error', stage: 'mt', message: 'boom' },
      { type: 'error', message: 'boom without stage' },
    ] satisfies ServerToClientMessage[];

    expect(up).toHaveLength(2);
    expect(down).toHaveLength(8);
  });

  // ---------------------------------------------------------------------
  // Ticket 002 — run identity on session.start.
  // These are COMPILE-TIME assertions: TypeScript types are erased before
  // vitest sees them, so their red/green signal comes from
  // `npx tsc --noEmit` (both tsconfig programs), not from the runner.
  // ---------------------------------------------------------------------
  type SessionStart = Extract<ClientToServerMessage, { type: 'session.start' }>;

  it('session.start carries optional recordingId / runId / origin', () => {
    const base = {
      type: 'session.start',
      mode: 'cascade',
      languagePair: 'en-es',
      direction: 'en->es',
      providers: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
    } as const;

    // Live sends none of the three — the message still typechecks.
    const live = { ...base } satisfies SessionStart;

    // Replay / sweep stamps run identity onto the same message.
    const replay = {
      ...base,
      recordingId: 'rec-1',
      runId: 'run-1',
      origin: 'sweep',
    } satisfies SessionStart;

    // Partial identity is legal too — each field is independently optional.
    const partial = { ...base, recordingId: 'rec-2' } satisfies SessionStart;

    expect(live.type).toBe('session.start');
    expect(replay.recordingId).toBe('rec-1');
    expect(replay.runId).toBe('run-1');
    expect(replay.origin).toBe('sweep');
    expect(partial.recordingId).toBe('rec-2');
  });

  it('origin is the closed run vocabulary "sweep" | "manual", not a free string', () => {
    type Origin = NonNullable<SessionStart['origin']>;

    const sweep: Origin = 'sweep';
    const manual: Origin = 'manual';

    // @ts-expect-error — origin is a closed vocabulary
    const bogus: Origin = 'whatever';

    // Exactly 'sweep' | 'manual' — neither narrower nor widened to string.
    type Exact = ['sweep' | 'manual'] extends [Origin]
      ? [Origin] extends ['sweep' | 'manual']
        ? true
        : false
      : false;
    const exact: Exact = true;

    expect([sweep, manual, bogus, exact]).toHaveLength(4);
  });

  it('cascade is context-free: session.start has NO context-policy field', () => {
    // PRD §7 — adding one would imply a control that does not exist.
    const keys: Array<keyof SessionStart> = [
      'type',
      'mode',
      'languagePair',
      'direction',
      'providers',
      'recordingId',
      'runId',
      'origin',
    ];
    type Extra = Exclude<keyof SessionStart, (typeof keys)[number]>;
    const noExtraMembers: [Extra] extends [never] ? true : false = true;

    expect(noExtraMembers).toBe(true);
  });

  describe('downstream binary framing (4-byte LE utt header + PCM16)', () => {
    it('round-trips utt and samples byte-exactly', () => {
      const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 12345, -12345]);
      const frame = encodeTtsFrame(7, pcm);
      expect(frame.byteLength).toBe(TTS_FRAME_HEADER_BYTES + pcm.byteLength);
      const decoded = decodeTtsFrame(frame);
      expect(decoded.utt).toBe(7);
      expect(Array.from(decoded.pcm)).toEqual(Array.from(pcm));
    });

    it('header is little-endian uint32', () => {
      const frame = encodeTtsFrame(0x01020304, new Int16Array(0));
      expect(Array.from(frame.subarray(0, 4))).toEqual([0x04, 0x03, 0x02, 0x01]);
    });

    it('decode is byteOffset-safe (view into a larger buffer, odd offset)', () => {
      const pcm = Int16Array.from([258, -2, 999]);
      const frame = encodeTtsFrame(42, pcm);
      // Place the frame at an odd offset inside a larger buffer.
      const big = new Uint8Array(frame.byteLength + 5);
      big.set(frame, 3);
      const view = new Uint8Array(big.buffer, 3, frame.byteLength);
      const decoded = decodeTtsFrame(view);
      expect(decoded.utt).toBe(42);
      expect(Array.from(decoded.pcm)).toEqual(Array.from(pcm));
    });

    it('encode is byteOffset-safe for the pcm view', () => {
      const backing = new Int16Array([9, 9, 5, 6, 7]);
      const view = backing.subarray(2); // byteOffset 4
      const decoded = decodeTtsFrame(encodeTtsFrame(1, view));
      expect(Array.from(decoded.pcm)).toEqual([5, 6, 7]);
    });

    it('rejects short and odd-bodied frames', () => {
      expect(() => decodeTtsFrame(new Uint8Array(3))).toThrow();
      expect(() => decodeTtsFrame(new Uint8Array(7))).toThrow();
    });
  });
});
