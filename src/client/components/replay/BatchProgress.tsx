/**
 * Ticket 013 — Batch sweep progress. STUB; contract in ReplayView.tsx.
 */

import type { ReactElement } from 'react';
import type { BatchConfiguration, BatchProgress as BatchProgressEvent } from '../../batch/runner';

export interface BatchProgressProps {
  /** Latest progress event, or null before the first one arrives. */
  progress: BatchProgressEvent | null;
  /** The sweep's matrix, so a configId can be shown by its label. */
  configurations: BatchConfiguration[];
  /** Retained reps per cell — the denominator of 'rep 3/5'. */
  reps: number;
  onCancel: () => void;
}

export default function BatchProgressPanel(_props: BatchProgressProps): ReactElement {
  return <div data-batch-progress />;
}
