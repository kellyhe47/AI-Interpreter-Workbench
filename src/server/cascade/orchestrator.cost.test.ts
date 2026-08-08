/**
 * TICKET 052 ROUND 2 — R2-2 and R2-6. The cascade cost path, end to end.
 *
 * `cascadeCostUsd` — the function whose entire purpose is to stop cascade
 * reporting `$0.00` — could have its body replaced with `return 0` and the
 * whole suite stayed green. So could summing the chunk list into one request,
 * so could `sttSamples += 0`, so could dropping the per-character shape gate.
 * The 1k-char floor was exercised only INSIDE `pricing.ts`; nothing ran it
 * through the code that builds the usage.
 *
 * THE SEAM THIS FILE NEEDS. A record carries one number (`costUnits`), and one
 * number cannot say WHICH stage was unmetered. `onTimings` already exists as
 * exactly this kind of observability hook; `onCost` is its cost twin, and the
 * per-stage attribution is the thing Experiment 2 exists to produce — a cascade
 * total that is `null` because MT reports no usage is a very different fact
 * from one that is null because nobody metered the audio.
 *
 *     onCost?: (utt: number, cost: CascadeCost) => void;
 *
 * declared on `RunCascadeOptions` beside `onTimings`. The casts below exist
 * only because that declaration has not landed.
 *
 * R2-6 — THE ELEVENLABS METER IS AT THE WRONG SEAM. `cascadeCostUsd` is handed
 * `targetPartials`, which is the MT TOKEN STREAM: one entry per token delta.
 * ElevenLabs opens ONE socket per utterance and sends one frame per chunk, so
 * a 40-token sentence models as 40 x the 1,000-char floor — $2.00 for one
 * sentence against ~$0.01 one-shot. The invariant that catches it without
 * naming an implementation: RE-CHOPPING THE SAME TEXT INTO MORE MT DELTAS MUST
 * NOT CHANGE THE TTS BILL. What is billed is what the synthesizer was asked to
 * say, not how the translator happened to punctuate its stream.
 */

import { describe, expect, it } from 'vitest';

import { ELEVENLABS_MIN_CHARS_PER_REQUEST, RATE_CARD, type CharacterRate, type CostResult } from '../../core/pricing';
import { SAMPLE_RATE } from '../../core/protocol';
import { DEFAULT_CASCADE_TRIPLE, type ProviderTriple } from '../../core/arms';
import type { MtProvider, ProviderCallOpts, SttEvent, SttProvider } from '../../core/types';
import { FixtureTts } from '../../core/fixtures/index';
import { runCascade } from './orchestrator';
import type { CascadeEvent, CascadeProviders, RunCascadeOptions } from './orchestrator';

/** The two cascade arms, by MODEL id — what `session.start` actually carries. */
const ARM_B_TRIPLE: ProviderTriple = { ...DEFAULT_CASCADE_TRIPLE };
const ARM_C_TTS = 'eleven_flash_v2_5';
const ARM_C_TRIPLE: ProviderTriple = { ...DEFAULT_CASCADE_TRIPLE, tts: ARM_C_TTS };

/* ------------------------------------------------------------------ fakes -- */

/** `chunks` Int16Arrays of `samplesPerChunk` samples each — one turn. */
function audioOf(chunks: number, samplesPerChunk: number): AsyncIterable<Int16Array> {
  return (async function* () {
    for (let i = 0; i < chunks; i += 1) yield new Int16Array(samplesPerChunk);
  })();
}

class OneTurnStt implements SttProvider {
  readonly name = 'openai';
  async *transcribe(
    audio: AsyncIterable<Int16Array>,
    _opts?: ProviderCallOpts,
  ): AsyncGenerator<SttEvent, void, void> {
    // Drain EVERY chunk, so the orchestrator's sample meter sees the whole turn.
    for await (const _chunk of audio) {
      /* consume */
    }
    yield { type: 'final', text: 'hello world', tStart: 0, tEnd: 80 };
  }
}

/** An MT that yields a fixed text split into exactly `deltas` token chunks. */
class ChoppedMt implements MtProvider {
  readonly name = 'openai';
  readonly streaming = true;
  constructor(
    private readonly text: string,
    private readonly deltas: number,
  ) {}

  async *translate(_text: string, _opts?: ProviderCallOpts): AsyncGenerator<string, void, void> {
    const size = Math.ceil(this.text.length / this.deltas);
    for (let i = 0; i < this.text.length; i += size) yield this.text.slice(i, i + size);
  }
}

function providersFor(text: string, deltas: number): CascadeProviders {
  return {
    stt: new OneTurnStt(),
    mt: new ChoppedMt(text, deltas),
    tts: new FixtureTts({ samplesPerChar: 2 }),
  };
}

/** `RunCascadeOptions` plus the `onCost` seam this ticket adds. */
type CostOptions = RunCascadeOptions & {
  onCost?: (utt: number, cost: { perStage: Record<string, CostResult>; total: CostResult }) => void;
};

interface TurnResult {
  costUnits: number | null;
  cost?: { perStage: Record<string, CostResult>; total: CostResult };
}

async function runOneTurn(opts: {
  models?: { stt: string; mt: string; tts: string };
  text?: string;
  deltas?: number;
  audioChunks?: number;
  samplesPerChunk?: number;
}): Promise<TurnResult> {
  const text = opts.text ?? 'hola mundo';
  let cost: TurnResult['cost'];
  const runOpts: CostOptions = {
    models: opts.models,
    onCost: (_utt, c) => {
      cost = c;
    },
  };
  const events: CascadeEvent[] = [];
  for await (const e of runCascade(
    audioOf(opts.audioChunks ?? 3, opts.samplesPerChunk ?? 24_000),
    providersFor(text, opts.deltas ?? 2),
    runOpts as RunCascadeOptions,
  )) {
    events.push(e);
  }
  const complete = events.find((e) => e.type === 'utterance.complete');
  if (complete === undefined || complete.type !== 'utterance.complete') {
    throw new Error('no utterance.complete event');
  }
  return { costUnits: complete.record.costUnits, cost };
}

const CHAR_RATE = RATE_CARD[ARM_C_TTS] as CharacterRate;
/** What ONE ElevenLabs request costs at the 1,000-character floor. */
const FLOOR_USD = (ELEVENLABS_MIN_CHARS_PER_REQUEST / 1000) * CHAR_RATE.perThousandCharsUsd;

function usdOf(cost: CostResult): number {
  expect(cost.measured).toBe(true);
  return cost.usd as number;
}

/* ================================================================= R2-2 ==== */

describe('R2-2 · a cascade turn nobody could fully price reports NOT MEASURED', () => {
  it('carries costUnits null on Arm B, because MT reports no usage', async () => {
    // `return 0` in `cascadeCostUsd` lands here as `0` — a cascade turn
    // published as free, which is exactly the string this ticket deletes.
    const { costUnits } = await runOneTurn({ models: ARM_B_TRIPLE });
    expect(costUnits).toBeNull();
  });

  it('names MT as the stage the hole is in — not STT, not TTS', async () => {
    // ONE number cannot say this, and "the cascade cost is unknown" is a much
    // weaker finding than "everything but the translator is metered".
    const { cost } = await runOneTurn({ models: ARM_B_TRIPLE });
    expect(cost).toBeDefined();
    expect(cost!.perStage.mt!.measured).toBe(false);
    expect(cost!.perStage.mt).toMatchObject({ reason: 'no-usage-reported' });
    expect(cost!.total.measured).toBe(false);
    expect(cost!.total).toMatchObject({ reason: 'stage-unmeasured' });
  });

  it('reports NOT MEASURED when no model ids reached the orchestrator at all', async () => {
    // The `ws.ts` wiring seam failing open. A vendor name cannot price
    // anything, so an un-forwarded triple must not silently become $0.
    const { costUnits, cost } = await runOneTurn({ models: undefined });
    expect(costUnits).toBeNull();
    expect(cost!.perStage.stt!.measured).toBe(false);
  });
});

describe('R2-2 · the STT stage is metered from the AUDIO ACTUALLY HANDED TO IT', () => {
  it('meters every chunk of the turn, not just the first', async () => {
    // `sttSamples += r.value.length` -> `+= 0` leaves only the peeked chunk,
    // so a three-chunk turn would bill as a one-chunk turn: a third of the
    // real STT cost, reported as a measurement.
    const chunks = 3;
    const samplesPerChunk = 24_000;
    const { cost } = await runOneTurn({ models: ARM_B_TRIPLE, audioChunks: chunks, samplesPerChunk });

    const expectedMinutes = (chunks * samplesPerChunk) / SAMPLE_RATE / 60;
    const perMinute = (RATE_CARD['gpt-4o-transcribe'] as { perMinuteUsd: number }).perMinuteUsd;
    expect(usdOf(cost!.perStage.stt!)).toBeCloseTo(expectedMinutes * perMinute, 10);
  });

  it('scales with the audio — twice the samples costs twice as much', async () => {
    // The identity, so no constant satisfies both this and the figure above.
    const one = await runOneTurn({ models: ARM_B_TRIPLE, audioChunks: 2, samplesPerChunk: 24_000 });
    const two = await runOneTurn({ models: ARM_B_TRIPLE, audioChunks: 4, samplesPerChunk: 24_000 });
    expect(usdOf(two.cost!.perStage.stt!)).toBeCloseTo(usdOf(one.cost!.perStage.stt!) * 2, 10);
  });
});

describe('R2-2 · the ElevenLabs meter is PER REQUEST, end to end', () => {
  it('bills an Arm C turn as N floored requests, not one summed character count', async () => {
    // Two short requests of 100 chars each: $0.10 at the per-request floor,
    // $0.05 if the list is summed into one 200-char request. The 1k-char trap
    // is the difference, and it is what could make Arm C the most expensive
    // arm in the study.
    const { cost } = await runOneTurn({
      models: ARM_C_TRIPLE,
      text: 'x'.repeat(200),
      deltas: 2,
    });
    expect(usdOf(cost!.perStage.tts!)).toBeCloseTo(2 * FLOOR_USD, 10);
  });

  it('does not meter a TOKEN-billed TTS model on the character meter', async () => {
    // Dropping the `rateFor(models.tts)?.shape === 'per-character'` gate hands
    // gpt-4o-mini-tts a character count it does not bill on. That is a
    // shape-mismatch, which is a DIFFERENT and less informative statement than
    // "this stage was not metered".
    const { cost } = await runOneTurn({ models: ARM_B_TRIPLE, text: 'x'.repeat(200), deltas: 2 });
    expect(cost!.perStage.tts!.measured).toBe(false);
    expect(cost!.perStage.tts).toMatchObject({ reason: 'no-usage-reported' });
  });

  it('labels an Arm C figure UNVERIFIED — the floor has never met an invoice', async () => {
    const { cost } = await runOneTurn({ models: ARM_C_TRIPLE, text: 'x'.repeat(200), deltas: 2 });
    expect(cost!.perStage.tts!.verified).toBe(false);
  });
});

/* ================================================================= R2-6 ==== */

describe('R2-6 · the TTS bill follows what was SYNTHESIZED, not how MT chopped it', () => {
  it('is unchanged when the same sentence arrives in more MT token deltas', async () => {
    // THE INVARIANT. `targetPartials` is the MT token stream; billing it means
    // a 40-token sentence models as 40 x the 1,000-char floor = $2.00 for one
    // sentence, against ~$0.01 one-shot. Whatever the meter is attached to, it
    // must not be the translator's punctuation.
    const text = 'x'.repeat(400);
    const few = await runOneTurn({ models: ARM_C_TRIPLE, text, deltas: 2 });
    const many = await runOneTurn({ models: ARM_C_TRIPLE, text, deltas: 40 });
    expect(usdOf(many.cost!.perStage.tts!)).toBeCloseTo(usdOf(few.cost!.perStage.tts!), 10);
  });

  it('does not bill a single sentence at forty floored requests', async () => {
    // The absolute ceiling, stated so the invariant above cannot be satisfied
    // by making BOTH sides equally wrong.
    const { cost } = await runOneTurn({
      models: ARM_C_TRIPLE,
      text: 'x'.repeat(400),
      deltas: 40,
    });
    expect(usdOf(cost!.perStage.tts!)).toBeLessThan(40 * FLOOR_USD);
  });
});
