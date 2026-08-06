/**
 * Ticket 009 — Batch runner (sweep). STUB ONLY (TDD red phase).
 *
 * Types + throwing bodies so `runner.test.ts` compiles. No implementation.
 */

import type { RunOrigin } from '../../core/protocol';
import type { RunOnceConfig, RunOnceResult, RunnerDeps } from '../replay/runner';
import type { Run } from '../state/ledger';

/** One selectable configuration in the sweep matrix. */
export interface BatchConfiguration {
  /** Stable id used in progress events and the summary. */
  id: string;
  config: RunOnceConfig;
  label?: string;
}

/** What the runner asks the single-run executor to do. */
export interface BatchExecutorRequest {
  recordingId: string;
  configId: string;
  config: RunOnceConfig;
  /** 1-based repetition index; 0 for the warmup, which counts as no rep. */
  repIndex: number;
  /** 1 = first try, 2 = the single retry. Never more. */
  attempt: number;
  /** True for the discarded warmup run of a configuration. */
  warmup: boolean;
  /** 'sweep' for a retained run; never 'sweep' for the warmup. */
  origin: RunOrigin;
  /** Aborted when the batch is cancelled or the per-run timeout elapses. */
  signal: AbortSignal;
}

export type BatchExecutor = (request: BatchExecutorRequest) => Promise<RunOnceResult>;

export interface BatchProgress {
  /** 1-based position in the MEASURED matrix; 0 for a warmup, which holds no
   * position in it (so the ratio runIndex/totalRuns never exceeds 1). */
  runIndex: number;
  /** Measured matrix size: recordings × configurations × reps. Warmups are
   * NOT counted — the mock's "run 17 of 45" is 3 × 3 × 5 retained runs. */
  totalRuns: number;
  recordingId: string;
  configId: string;
  repIndex: number;
  warmup: boolean;
  elapsedMs: number;
  /** null until the runner has a sample to estimate from. */
  estimatedRemainingMs: number | null;
}

export interface BatchCellRef {
  recordingId: string;
  configId: string;
  repIndex: number;
}

export interface BatchFailure extends BatchCellRef {
  status: 'failed';
  /** Attempts spent on this cell — 2 once the single retry is used. */
  attempts: number;
  runId?: string;
  error?: string;
}

export interface BatchDiscard extends BatchCellRef {
  reason: 'warmup';
  runId?: string;
}

export interface BatchConfigSummary {
  configId: string;
  /** Reps the sweep set out to retain — i.e. `options.reps`, exactly. */
  intendedReps: number;
  /** Reps that actually produced a retained, complete run. */
  completedReps: number;
}

export interface BatchSummary {
  status: 'complete' | 'cancelled';
  /** Measured matrix size — retained runs only, warmups excluded. */
  totalRuns: number;
  /** Measured cells actually attempted. Warmups are not cells. */
  attemptedRuns: number;
  completedRuns: number;
  warmupDiscardApplied: boolean;
  counterbalancingApplied: boolean;
  discarded: BatchDiscard[];
  failures: BatchFailure[];
  configurations: BatchConfigSummary[];
  /** Retained runs in execution order. Every one carries origin 'sweep'. */
  runs: Run[];
  elapsedMs: number;
}

export interface BatchDeps {
  execute: BatchExecutor;
  /** Epoch-ms clock. */
  now: () => number;
}

export interface BatchOptions {
  recordingIds: string[];
  configurations: BatchConfiguration[];
  /**
   * RETAINED reps per (recording × configuration) — PRD §17 22c, "5
   * repetitions retained". The warmup is an ADDITIONAL, uncounted execution,
   * so a cell runs `reps + 1` times and aggregates `reps` samples.
   */
  reps: number;
  /** Per-run completion timeout; an over-running run is aborted and failed. */
  runTimeoutMs: number;
  deps: BatchDeps;
  onProgress?: (progress: BatchProgress) => void;
}

export interface BatchHandle {
  done: Promise<BatchSummary>;
  cancel: () => void;
}

export function startBatch(_options: BatchOptions): BatchHandle {
  throw new Error('not implemented');
}

/** Adapts ticket 008's runOnce to the batch executor seam. */
export function createRunOnceExecutor(_deps: RunnerDeps): BatchExecutor {
  throw new Error('not implemented');
}
