/**
 * TICKET 033 — the provenance line and MULTIPLE corpus versions.
 *
 * THE HAZARD this file exists for. `buildProvenance` picked the FIRST
 * `annotations.corpusVersion` it found and rendered it as though every sample
 * behind the figure came from it. While no Run carried one that was harmless;
 * the moment 033 makes them real, an aggregate spanning `corpus-v1` and
 * `corpus-v2` reports one of them — a confident, WRONG provenance claim, which
 * is strictly worse than the honest `corpus version unrecorded` it replaces
 * (PRD §8: a number without provenance is a claim; a number with a false one is
 * a lie).
 *
 * THE RULING PINNED HERE: an aggregate spanning several versions NAMES EVERY
 * VERSION PRESENT, deduped and sorted ascending so the order does not depend on
 * ledger append order. Aggregation is NOT refused — the samples are real
 * measurements and dropping them would destroy evidence to avoid a labelling
 * problem. What the line owes the reader is that the input changed.
 *
 * `Provenance.corpusVersions` is the full list. `Provenance.corpusVersion` is
 * the single version when there is EXACTLY one and null otherwise, so a caller
 * that renders it alone degrades to "unrecorded" on a mixed aggregate — honest,
 * never wrong.
 */
import { describe, expect, it } from 'vitest';

import { RunLedger, isAggregatableRun } from '../../state/ledger';
import { deriveExperimentAggregates, type AnnotatedRun } from './derive';
import {
  CORPUS_VERSION,
  makeRecordingEntity,
  makeRunEntity,
  runWithLatency,
} from './testRecords';

const V1 = 'corpus-en-es-v1';
const V2 = 'corpus-en-es-v2';
const UNRECORDED = 'corpus version unrecorded';

/**
 * A one-recording Arm-B sweep whose reps carry the given versions in the given
 * ORDER — so append order and sorted order can be told apart.
 */
function ledgerWithVersions(versions: (string | undefined)[]): RunLedger {
  const ledger = new RunLedger();
  ledger.appendRecording(makeRecordingEntity({ id: 'rec-cv' }));
  versions.forEach((version, i) => {
    const annotations: AnnotatedRun['annotations'] = { utteranceId: 'u1', repIndex: i + 1 };
    if (version !== undefined) annotations.corpusVersion = version;
    ledger.appendRun(
      runWithLatency(800 + i * 100, {
        id: `run-cv-${i + 1}`,
        recordingId: 'rec-cv',
        annotations,
      }),
    );
  });
  return ledger;
}

function provenanceOf(ledger: RunLedger) {
  const arm = deriveExperimentAggregates(ledger).perArm['B'];
  if (!arm) throw new Error('Arm B produced no aggregate');
  return { p: arm.provenance, n: arm.n, p50Ms: arm.p50Ms };
}

describe('ticket 033 — one corpus version: the line names it', () => {
  it('a homogeneous aggregate reports the version and drops "unrecorded"', () => {
    const { p } = provenanceOf(ledgerWithVersions([V1, V1, V1]));

    expect(p.corpusVersions).toEqual([V1]);
    expect(p.corpusVersion).toBe(V1);
    expect(p.line).toContain(V1);
    expect(p.line).not.toContain(UNRECORDED);
  });

  it('REGRESSION GUARD: no version anywhere still reads "corpus version unrecorded"', () => {
    // The honest fallback stays. This is what a mic-sourced or pre-033 ledger
    // must keep saying.
    const { p } = provenanceOf(ledgerWithVersions([undefined, undefined]));

    expect(p.corpusVersions).toEqual([]);
    expect(p.corpusVersion).toBeNull();
    expect(p.line).toContain(UNRECORDED);
  });
});

describe('ticket 033 — TWO corpus versions: the line names BOTH, never one', () => {
  it('names every version present, sorted ascending regardless of append order', () => {
    // v2 is appended FIRST, so "pick the first" would render v2 alone.
    const { p } = provenanceOf(ledgerWithVersions([V2, V1, V2, V1]));

    expect(p.corpusVersions).toEqual([V1, V2]);
    expect(p.line).toContain(`${V1}, ${V2}`);
    // The load-bearing negative: neither version may stand alone as the claim.
    expect(p.line).toContain(V1);
    expect(p.line).toContain(V2);
    expect(p.line).not.toContain(UNRECORDED);
  });

  it('the singular field is NULL on a mixed aggregate — it never picks one', () => {
    const { p } = provenanceOf(ledgerWithVersions([V2, V1]));

    // A caller that renders `corpusVersion` alone degrades to "unrecorded",
    // which is honest. It must never be handed V1 or V2 as if it were the one.
    expect(p.corpusVersion).toBeNull();
    expect(p.corpusVersions).toHaveLength(2);
  });

  it('a version present on only SOME runs is still named beside the ones that declare none', () => {
    const { p } = provenanceOf(ledgerWithVersions([undefined, V1, undefined]));

    expect(p.corpusVersions).toEqual([V1]);
    // Exactly one version is actually named, so the singular field is it — the
    // undeclared runs are silence, not a second version.
    expect(p.corpusVersion).toBe(V1);
    expect(p.line).not.toContain(UNRECORDED);
  });

  it('duplicates collapse: five reps of one version name it ONCE', () => {
    const { p } = provenanceOf(ledgerWithVersions([V1, V1, V1, V1, V1]));

    expect(p.corpusVersions).toEqual([V1]);
    expect(p.line.match(new RegExp(V1, 'g'))).toHaveLength(1);
  });
});

describe('ticket 033 — naming both versions moves NO figure', () => {
  it('a mixed-version aggregate still aggregates: n and p50 are unchanged', () => {
    // Refusing to aggregate across versions was the alternative; it is rejected
    // here. The measurements are real and stay in the figure — only the label
    // changes.
    const mixed = provenanceOf(ledgerWithVersions([V2, V1, V2, V1]));
    const homogeneous = provenanceOf(ledgerWithVersions([V1, V1, V1, V1]));

    expect(mixed.n).toBe(homogeneous.n);
    expect(mixed.p50Ms).toBe(homogeneous.p50Ms);
    expect(mixed.p.completedReps).toBe(homogeneous.p.completedReps);
    expect(mixed.p.intendedReps).toBe(homogeneous.p.intendedReps);
    expect(mixed.p.utteranceCount).toBe(homogeneous.p.utteranceCount);
    expect(mixed.p.attemptedSamples).toBe(homogeneous.p.attemptedSamples);
  });

  it('an EXCLUDED run contributes no version — provenance follows the figures', () => {
    const ledger = new RunLedger();
    ledger.appendRecording(makeRecordingEntity({ id: 'rec-cv' }));
    ledger.appendRun(
      runWithLatency(900, {
        id: 'run-in',
        recordingId: 'rec-cv',
        annotations: { utteranceId: 'u1', repIndex: 1, corpusVersion: V1 },
      }),
    );
    // Ad-hoc origin: outside every experiment figure, so its version is not
    // provenance FOR that figure.
    ledger.appendRun(
      runWithLatency(900, {
        id: 'run-out',
        recordingId: 'rec-cv',
        origin: 'manual',
        annotations: { utteranceId: 'u1', repIndex: 2, corpusVersion: V2 },
      }),
    );

    const { p } = provenanceOf(ledger);
    expect(p.corpusVersions).toEqual([V1]);
    expect(p.line).not.toContain(V2);
  });
});

describe('ticket 033 — the Run-level gate is UNCHANGED', () => {
  it('isAggregatableRun ignores corpusVersion entirely: data, never a gate', () => {
    const withVersion = makeRunEntity({ annotations: { corpusVersion: CORPUS_VERSION } });
    const without = makeRunEntity({ annotations: {} });
    const noEnvelope = makeRunEntity({ annotations: undefined });

    for (const run of [withVersion, without, noEnvelope]) {
      expect(isAggregatableRun(run)).toBe(true);
    }
    // ...and a run excluded for a REAL reason stays excluded no matter what
    // version it declares.
    expect(
      isAggregatableRun(
        makeRunEntity({ origin: 'manual', annotations: { corpusVersion: CORPUS_VERSION } }),
      ),
    ).toBe(false);
  });
});
