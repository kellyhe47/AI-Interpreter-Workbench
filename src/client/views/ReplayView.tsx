/**
 * Ticket 013 — Replay view: recordings library, run config panel, runs list,
 * batch progress.
 *
 * STUB. The implementation is ticket 013's green step; this file exists so
 * ReplayView.test.tsx compiles. The contract below is what the tests lock.
 *
 * ============================== DOM CONTRACT ==============================
 * Root [data-replay-view]. Header: 'Replay', the verbatim subline, and a
 * [data-record-new] button named 'Record new clip · max 1 min'.
 *
 * RecordingsLibrary [data-recordings-library]
 *   [data-recording-row][data-recording=<id>][data-origin='mic'|'corpus']
 *     [data-selected='true'|'false'], containing
 *       [data-recording-label]      the label text
 *       [data-origin-pill]          'corpus' | 'mic'
 *       [data-recording-language]   the source language code
 *       [data-recording-duration]   M:SS
 *       [data-recording-run-count]  '{n} runs' — every Run, failed included
 *       [data-edit-label]           button, accessible name 'Edit label'
 *       [data-delete-recording]     button, 'Delete recording' — MIC ONLY.
 *                                   A corpus row renders NO delete control.
 *   Editing: [data-edit-label] swaps in [data-label-input] (a textbox named
 *   'Recording label'); Enter commits through recordings.patchLabel(id, next).
 *   Empty: [data-recordings-empty] and zero [data-recording-row].
 *   Footer [data-library-footer] carries the lifecycle copy verbatim.
 *   Selection is idempotent: clicking the selected row keeps it selected.
 *
 * RunConfigPanel [data-run-config-panel]
 *   architecture toggle: buttons 'Realtime' / 'Cascade' with aria-pressed
 *   [data-stage-select='stt'|'mt'|'tts'] — <select> elements, one <option>
 *     per MENUS entry, accessible name = the stage. Cascade only; realtime
 *     renders none.
 *   [data-derived-tag='A'|'B'|'C'|'ad-hoc'] — READ-ONLY pill, text
 *     'derived tag: Arm B' | 'derived tag: ad-hoc'. Derived live from the
 *     panel state; never a control, and nothing anywhere sets a tag.
 *   [data-replay-context][data-locked='true'] — pinned to zero, contains NO
 *     enabled control of any kind.
 *   [data-pinned-note] verbatim; buttons 'Run' and 'Batch sweep…'.
 *   Defaults: architecture 'cascade', providers DEFAULT_CASCADE_TRIPLE, so an
 *   untouched panel derives Arm B.
 *
 * RunsList [data-runs-list]
 *   [data-run-card][data-run=<id>][data-arm=<tag>][data-status=...] with
 *     [data-run-arm-pill]  armLabel(tag) — non-interactive
 *     [data-run-config]    architecture + every model id of the run
 *     [data-run-meta][data-mono]  'origin {origin} · rep {n} · …'
 *     [data-run-status]    'complete' | 'failed'
 *   complete only: [data-run-play] (button named 'play'),
 *     [data-run-stage=<stage>] one per interval in order, '{label} {ms} ms',
 *     [data-run-total] '{ms} ms', [data-run-cost] '$0.021/min'
 *     ($/min = run.cost ÷ recording minutes).
 *   failed only: [data-run-failure][data-failed-stage=<stage>], naming the
 *     stage and ending '— run saved as failed, excluded from every aggregate'.
 *     No play control, no stage cells.
 *   NOTHING AUTOPLAYS: deps.playRun fires on click and never on render.
 *
 * BatchProgress [data-batch-progress] — absent until 'Batch sweep…'
 *   [data-batch-position]  'run {i} of {n} · {recordingId} × {label} · rep i/n'
 *   [data-batch-clock]     'elapsed M:SS · est. remaining M:SS'
 *   [data-batch-bar]       role=progressbar, aria-valuenow/min/max
 *   [data-batch-controls-note] verbatim
 *   button 'Cancel — keep completed runs' → handle.cancel(); when `done`
 *   settles the panel unmounts and every completed run is still listed.
 * ==========================================================================
 */

import type { ReactElement } from 'react';
import type { BatchConfiguration, BatchHandle, BatchProgress } from '../batch/runner';
import type { RecordingsClient, RunsClient } from '../replay/recordingsClient';
import type { RunOnceConfig, RunOnceResult } from '../replay/runner';

/** One manual run request, as the view asks for it. */
export interface ReplayRunRequest {
  recordingId: string;
  config: RunOnceConfig;
  signal?: AbortSignal;
}

/** The sweep the view asks for; the executor/timeout seams belong to the host. */
export interface ReplayBatchRequest {
  recordingIds: string[];
  configurations: BatchConfiguration[];
  reps: number;
  onProgress?: (progress: BatchProgress) => void;
}

/** Everything the view reaches the outside world through. Nothing is global. */
export interface ReplayDeps {
  recordings: RecordingsClient;
  runs: RunsClient;
  runOnce: (request: ReplayRunRequest) => Promise<RunOnceResult>;
  startBatch: (request: ReplayBatchRequest) => BatchHandle;
  /** On-demand playback of a run's output audio. NEVER called at render. */
  playRun: (runId: string) => void;
  now: () => number;
  newId: () => string;
}

export interface ReplayViewProps {
  deps: ReplayDeps;
}

export default function ReplayView(_props: ReplayViewProps): ReactElement {
  return <div data-replay-view />;
}
