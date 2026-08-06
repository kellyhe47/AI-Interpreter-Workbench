/**
 * Ticket 013 — Run configuration panel. STUB; contract in ReplayView.tsx.
 *
 * The panel is a pure control surface over a RunConfig. It NEVER carries an
 * arm tag in its state: the pill is deriveArmTag(config), recomputed on every
 * render (PRD §6 quarantine).
 */

import type { ReactElement } from 'react';
import type { Mode } from '../../../core/timing';
import type { ProviderTriple } from '../../../core/arms';

export interface ReplayConfigState {
  architecture: Mode;
  realtimeModel: string;
  providers: ProviderTriple;
}

export interface RunConfigPanelProps {
  /** Label of the selected Recording, or null when none is selected. */
  recordingLabel: string | null;
  config: ReplayConfigState;
  onConfigChange: (next: ReplayConfigState) => void;
  onRun: () => void;
  onBatchSweep: () => void;
  /** Rendered inside the panel while a sweep is in flight. */
  batchProgress?: ReactElement | null;
}

export default function RunConfigPanel(_props: RunConfigPanelProps): ReactElement {
  return <div data-run-config-panel />;
}
