/**
 * TICKET 051 — where cascade's `vad_fired` comes from.
 *
 * The orchestrator used to write `vad_fired = stt_final = Date.now()` at the
 * turn-final, with the doc-comment conceding it was "semantically weak". The
 * consequence only became visible when Live started rendering its stages by
 * the span they measure: "detected end of speech -> transcript" was then
 * identically 0 ms on every utterance, which is a fabricated figure, not a
 * missing one.
 *
 * The rule: when the STT provider announces the endpointer's decision
 * (`SttEvent { type: 'speech_stopped' }`), THAT instant is `vad_fired`.
 * A provider that never announces one keeps today's behaviour exactly —
 * `vad_fired === stt_final` — so nothing that already ran moves.
 *
 * NOTE ON REPLAY: `endpointing` in Replay is `vad_fired − speech_end`, and
 * `speech_end` still comes from the corpus manifest. This makes that figure
 * MORE correct for openai-stt runs, and moves no aggregate: p50/p95 are
 * `audio_queued − speech_end`, which neither endpoint of this change touches.
 */

import { describe, expect, it } from 'vitest';
import { FixtureMt, FixtureTts } from '../../core/fixtures/index';
import type { ProviderCallOpts, SttEvent, SttProvider } from '../../core/types';
import type { CascadeTimestamps } from '../../core/timing';
import { runCascade } from './orchestrator';
import type { CascadeEvent, CascadeProviders } from './orchestrator';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One chunk of audio == one turn for these fakes. */
function oneTurn(): AsyncIterable<Int16Array> {
  return (async function* () {
    yield new Int16Array(480);
  })();
}

/** An STT whose turn optionally announces the endpointer before transcribing. */
class ScriptedStt implements SttProvider {
  readonly name = 'scripted-stt';
  constructor(private readonly announces: boolean) {}

  async *transcribe(
    audio: AsyncIterable<Int16Array>,
    _opts?: ProviderCallOpts,
  ): AsyncGenerator<SttEvent, void, void> {
    for await (const _chunk of audio) break;
    yield { type: 'partial', text: 'hel', tStart: 0, tEnd: 10 };
    if (this.announces) {
      // The endpointer decides the speaker has stopped...
      yield { type: 'speech_stopped', text: '', tStart: 0, tEnd: 20 };
    }
    // ...and the closing transcript lands a measurable while later.
    await sleep(60);
    yield { type: 'final', text: 'hello world', tStart: 0, tEnd: 80 };
  }
}

function providers(announces: boolean): CascadeProviders {
  return {
    stt: new ScriptedStt(announces),
    mt: new FixtureMt({ translation: 'hola mundo' }),
    tts: new FixtureTts({ samplesPerChar: 4 }),
  };
}

async function recordOfOneUtterance(announces: boolean) {
  const events: CascadeEvent[] = [];
  for await (const e of runCascade(oneTurn(), providers(announces))) events.push(e);
  const complete = events.find((e) => e.type === 'utterance.complete');
  expect(complete, 'expected one completed utterance').toBeDefined();
  return (complete as Extract<CascadeEvent, { type: 'utterance.complete' }>).record;
}

async function timingsOfOneUtterance(announces: boolean): Promise<CascadeTimestamps> {
  return (await recordOfOneUtterance(announces)).timings as CascadeTimestamps;
}

describe('cascade vad_fired', () => {
  it('is stamped at the endpointer announcement, strictly before the transcript', async () => {
    const t = await timingsOfOneUtterance(true);

    expect(t.vad_fired).toBeTypeOf('number');
    expect(t.stt_final).toBeTypeOf('number');
    // The whole point: a REAL, non-zero "detected end of speech -> transcript"
    // span. The fake sleeps 60 ms between the two events; 25 ms of slack keeps
    // this off a timer edge without letting a 0 ms stamp through.
    expect(t.stt_final! - t.vad_fired!).toBeGreaterThanOrEqual(25);
  });

  it('GUARD: a provider that announces nothing keeps vad_fired === stt_final', async () => {
    const t = await timingsOfOneUtterance(false);
    expect(t.vad_fired).toBe(t.stt_final);
  });

  it("the endpointer's announcement is not mistaken for the transcript", async () => {
    // `speech_stopped` carries no text. A branch that treats any non-'partial'
    // event as the turn-final would finalise the turn on an empty string —
    // which the orchestrator drops as an empty turn, losing the utterance
    // entirely.
    const events: CascadeEvent[] = [];
    for await (const e of runCascade(oneTurn(), providers(true))) events.push(e);

    const finals = events.filter((e) => e.type === 'stt.final');
    expect(finals).toHaveLength(1);
    expect((finals[0] as Extract<CascadeEvent, { type: 'stt.final' }>).text).toBe('hello world');
  });
});

/**
 * TICKET 051 ROUND 2 (R2-4) — and the record must not CLAIM a mark it lacks.
 *
 * PRD §7: "`speech_end` is corpus ground truth in benchmark runs and
 * VAD-derived in live sessions; the record marks which." The server stamps no
 * `speech_end` at all — option (c) is precisely the decision not to
 * back-derive one — yet every record it emits declared `speechEndSource:
 * 'vad'`. Nothing reads that field today, which is exactly why it could go
 * false unnoticed: it is PERSISTED and EXPORTED, so it outlives the session
 * that wrote it and lands in the bundle as an assertion about a measurement
 * that was never taken.
 */
describe('speechEndSource never claims a mark the record does not carry', () => {
  it("a cascade record with no speech_end declares 'none', not 'vad'", async () => {
    const record = await recordOfOneUtterance(true);
    const timings = record.timings as CascadeTimestamps;

    expect(timings.speech_end).toBeUndefined();
    expect(record.speechEndSource).toBe('none');
    // 'vad' would mean "this speech_end came from the endpointer", and there
    // is no speech_end on this record at all.
    expect(record.speechEndSource).not.toBe('vad');
  });

  it('GUARD: the endpointer mark itself is still stamped — only the CLAIM changed', async () => {
    const record = await recordOfOneUtterance(true);
    expect((record.timings as CascadeTimestamps).vad_fired).toBeTypeOf('number');
  });
});
