import { describe, expect, it } from 'vitest';
import {
  checkTurnFinalMapping,
  collect,
  describeMtContract,
  describeSttContract,
  describeTtsContract,
} from './index';
import { FixtureMt, FixtureStt, FixtureTts } from '../fixtures/index';
import type { SttEvent, SttProvider } from '../types';

// --- Register all three fixtures against their contract suites. ---

describeSttContract('FixtureStt', () => new FixtureStt());

describeMtContract(
  'FixtureMt',
  () => new FixtureMt({ translation: 'hola mundo' }),
  { sourceText: 'hello world', expected: 'hola mundo' },
);

describeTtsContract('FixtureTts', () => new FixtureTts());

// --- Turn-final mapping checker: testable in isolation. ---

function ev(type: SttEvent['type'], text: string): SttEvent {
  return { type, text, tStart: 0, tEnd: 1 };
}

describe('checkTurnFinalMapping', () => {
  it('accepts partials followed by exactly one turn-final', () => {
    const verdict = checkTurnFinalMapping([
      ev('partial', 'hel'),
      ev('partial', 'hello'),
      ev('final', 'hello world'),
    ]);
    expect(verdict.ok).toBe(true);
  });

  it('accepts a lone turn-final with zero partials', () => {
    expect(checkTurnFinalMapping([ev('final', 'hi')]).ok).toBe(true);
  });

  const badCases: Array<{ name: string; events: SttEvent[] }> = [
    { name: 'no final at all', events: [ev('partial', 'a'), ev('partial', 'ab')] },
    {
      name: 'multiple finals (segment-final mis-mapped as turn-final)',
      events: [ev('final', 'hello'), ev('final', 'world')],
    },
    {
      name: 'partial after the final',
      events: [ev('final', 'hello'), ev('partial', 'wor')],
    },
    { name: 'empty turn', events: [] },
  ];

  for (const { name, events } of badCases) {
    it(`rejects: ${name}`, () => {
      const verdict = checkTurnFinalMapping(events);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBeTruthy();
    });
  }

  it('catches a deliberately mis-mapped provider that emits a final per segment', async () => {
    // Counter-example: maps every SEGMENT end to a 'final' event instead of
    // reserving 'final' for the TURN-final signal.
    const misMapped: SttProvider = {
      name: 'mis-mapped',
      transcribe: async function* () {
        yield ev('partial', 'hel');
        yield ev('final', 'hello');
        yield ev('partial', 'wor');
        yield ev('final', 'world');
      },
    };
    const events = await collect(
      misMapped.transcribe((async function* (): AsyncGenerator<Int16Array> {})()),
    );
    const verdict = checkTurnFinalMapping(events);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/exactly one/i);
  });
});
