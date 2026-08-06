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
import { ElevenLabsStt } from '../../server/providers/elevenlabs-stt';
import { AnthropicMt } from '../../server/providers/anthropic-mt';
import {
  FakeWsBase,
  chunkedBodyResponse,
  recordingFetch,
  recordingWsFactory,
} from '../../server/providers/test-support';

// --- Register all three fixtures against their contract suites. ---

describeSttContract('FixtureStt', () => new FixtureStt());

describeMtContract(
  'FixtureMt',
  () => new FixtureMt({ translation: 'hola mundo' }),
  { sourceText: 'hello world', expected: 'hola mundo' },
);

describeTtsContract('FixtureTts', () => new FixtureTts());

// ---------------------------------------------------------------------------
// Ticket 006 — the real adapters join the SAME suite, unmodified.
//
// "A new adapter passing the suite unmodified is the definition of
// interchangeable" (PRD §13). Nothing below touches `./index`: extending the
// suite means adding provider registrations here and nothing else.
//
// HARD RULE: no network. Both registrations inject a faked transport
// (`wsFactory` for the Scribe socket, `fetchImpl` for the Anthropic HTTP call),
// and a FRESH one per `factory()` call — the suite constructs a new provider
// for every case, so a shared socket or a once-consumable Response body would
// make the later cases hang.
// ---------------------------------------------------------------------------

/**
 * Fake ElevenLabs Scribe realtime socket, same pattern as
 * `src/server/providers/elevenlabs-stt.test.ts`: frame #0 is the config frame,
 * and the arrival of the first AUDIO frame starts replaying the scripted server
 * messages one macrotask apart. The socket closes once the script is exhausted,
 * so the suite's un-aborted case terminates on its own; nothing is emitted
 * after close, so the abort-mid-stream case cannot deadlock.
 */
class FakeScribeWs extends FakeWsBase {
  private started = false;

  constructor(
    url: string,
    opts: { headers?: Record<string, string> } | undefined,
    private readonly script: readonly unknown[],
  ) {
    super(url, opts);
  }

  protected override onClientMessage(): void {
    if (this.started || this.sent.length < 2) return;
    this.started = true;
    this.playScript();
  }

  private playScript(): void {
    let i = 0;
    const step = (): void => {
      if (this.closed) return;
      if (i >= this.script.length) {
        this.close();
        return;
      }
      this.serverMessage(this.script[i]);
      i += 1;
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }
}

/**
 * One well-formed spoken turn: two partials, then the committed message that is
 * the TURN-final signal. `text` is the full running transcript (Scribe sends
 * running transcripts, not deltas).
 */
const SCRIBE_TURN: readonly unknown[] = [
  { type: 'partial_transcript', text: 'hola' },
  { type: 'partial_transcript', text: 'hola mundo' },
  { type: 'committed_transcript', text: 'hola mundo' },
];

function makeScribeStt(): ElevenLabsStt {
  const { wsFactory } = recordingWsFactory(
    (url, o) => new FakeScribeWs(url, o, SCRIBE_TURN),
  );
  return new ElevenLabsStt({ apiKey: 'contract-test-key' }, { wsFactory });
}

describeSttContract('ElevenLabsStt', makeScribeStt);

/**
 * Anthropic SSE body: `event: <type>` + `data: <json>` per frame, the JSON
 * repeating its own type. No `[DONE]` sentinel — `message_stop` terminates.
 */
function anthropicSseBody(frames: readonly Record<string, unknown>[]): string {
  return frames
    .map((f) => `event: ${String(f['type'])}\ndata: ${JSON.stringify(f)}\n\n`)
    .join('');
}

function textDelta(text: string): Record<string, unknown> {
  return { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
}

/** Three text deltas -> 'Hola mundo' in >=2 chunks, satisfying `streaming: true`. */
const ANTHROPIC_TURN_BODY = anthropicSseBody([
  { type: 'message_start', message: { id: 'msg_contract' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  textDelta('Hola'),
  textDelta(' mun'),
  textDelta('do'),
  { type: 'content_block_stop', index: 0 },
  { type: 'message_stop' },
]);

function makeAnthropicMt(): AnthropicMt {
  // A new Response (and so a new, unconsumed body stream) per fetch call.
  const { fetchImpl } = recordingFetch(() =>
    chunkedBodyResponse([ANTHROPIC_TURN_BODY]),
  );
  return new AnthropicMt({ apiKey: 'contract-test-key' }, { fetchImpl });
}

describeMtContract('AnthropicMt', makeAnthropicMt, {
  sourceText: 'hello world',
  expected: 'Hola mundo',
});

// ---------------------------------------------------------------------------
// Guard: the shared suite's exported surface is unchanged. The real protection
// is the orchestrator diffing `./index.ts`; this only catches a signature being
// widened to accommodate one provider.
// REGRESSION GUARD — already passing before this ticket.
// ---------------------------------------------------------------------------

describe('shared contract suite surface is unchanged', () => {
  it('the three suite entry points still take (name, factory) with options defaulted', () => {
    expect(describeSttContract.length).toBe(2);
    expect(describeMtContract.length).toBe(2);
    expect(describeTtsContract.length).toBe(2);
  });

  it('the exported helpers still take exactly one argument', () => {
    expect(checkTurnFinalMapping.length).toBe(1);
    expect(collect.length).toBe(1);
  });
});

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
