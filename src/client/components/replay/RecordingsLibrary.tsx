/**
 * Ticket 013 — Recordings library. STUB; see the DOM contract in ReplayView.tsx.
 */

import type { ReactElement } from 'react';
import type { Recording } from '../../state/ledger';

export interface RecordingsLibraryProps {
  recordings: Recording[];
  /** Runs per recording id — every Run, failed included. */
  runCounts: Record<string, number>;
  selectedRecordingId: string | null;
  onSelect: (recordingId: string) => void;
  onRename: (recordingId: string, label: string) => void;
  /** Only ever wired for `origin: 'mic'` rows. */
  onDelete: (recordingId: string) => void;
}

export default function RecordingsLibrary(_props: RecordingsLibraryProps): ReactElement {
  return <div data-recordings-library />;
}
