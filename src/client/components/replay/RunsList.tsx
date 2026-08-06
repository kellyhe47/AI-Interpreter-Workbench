/**
 * Ticket 013 — Runs of the selected Recording. STUB; contract in ReplayView.tsx.
 */

import type { ReactElement } from 'react';
import type { Recording, Run } from '../../state/ledger';

export interface RunsListProps {
  /** The Recording these Runs replayed — its duration normalizes $/min. */
  recording: Recording | null;
  runs: Run[];
  /** On-demand playback. Called on click, never on render. */
  onPlay: (runId: string) => void;
}

export default function RunsList(_props: RunsListProps): ReactElement {
  return <div data-runs-list />;
}
