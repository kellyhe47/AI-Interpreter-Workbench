import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from './protocol';
import type { ClientToServerMessage, ServerToClientMessage } from './protocol';

describe('cascade wire protocol', () => {
  it('SAMPLE_RATE is 24000', () => {
    expect(SAMPLE_RATE).toBe(24000);
  });

  it('message unions typecheck (compile-time shape lock)', () => {
    const up = [
      {
        type: 'session.start',
        mode: 'cascade',
        languagePair: 'en-es',
        direction: 'en->es',
        providers: { stt: 'fixture', mt: 'fixture', tts: 'fixture' },
      },
      { type: 'audio.chunk', data: 'AAAA' },
      { type: 'utterance.end' },
      { type: 'session.end' },
    ] satisfies ClientToServerMessage[];

    const down = [
      { type: 'stt.partial', text: 'hel' },
      { type: 'stt.final', text: 'hello' },
      { type: 'mt.delta', text: 'ho' },
      { type: 'mt.final', text: 'hola' },
      { type: 'tts.chunk', data: 'AAAA' },
      { type: 'error', message: 'boom' },
    ] satisfies ServerToClientMessage[];

    expect(up).toHaveLength(4);
    expect(down).toHaveLength(6);
  });
});
