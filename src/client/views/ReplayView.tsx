/**
 * Ticket 013 — Replay view: recordings library, run config panel, runs list,
 * batch progress.
 *
 * NOTHING IS GLOBAL. The recordings client, the runs client, the single-run
 * executor, the sweep starter, the playback seam, the clock and the id minter
 * all arrive through `deps`. The view never touches the network, an
 * AudioContext or a real timer, which is what makes every rule below testable
 * rather than merely intended.
 *
 * MEMBERSHIP IS DERIVED, NEVER DECLARED (PRD §6, §17 22d-22e). The panel holds
 * a configuration and nothing else; its tag is deriveArmTag(configuration),
 * recomputed on render, and a run card's tag is runArmTag(run), recomputed
 * from the run's recipe. No control in this tree sets a tag.
 *
 * DELETION IS SOFT AND ONE-SIDED. Removing a mic Recording hides its row; its
 * Runs stay listed, and the Recording itself is kept in view state (flagged
 * deleted) so those Runs can still name the input that produced them and
 * normalize their cost by its duration.
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

import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { ARMS, DEFAULT_CASCADE_TRIPLE, REALTIME_MODEL } from '../../core/arms';
import BatchProgressPanel from '../components/replay/BatchProgress';
import RecordingsLibrary from '../components/replay/RecordingsLibrary';
import RunConfigPanel, { type ReplayConfigState } from '../components/replay/RunConfigPanel';
import RunsList from '../components/replay/RunsList';
import type { BatchConfiguration, BatchHandle, BatchProgress } from '../batch/runner';
import type { RecordingsClient, RunsClient } from '../replay/recordingsClient';
import type { RunOnceConfig, RunOnceResult } from '../replay/runner';
import type { Recording, Run } from '../state/ledger';

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

/* ------------------------------------------------------------------ copy -- */

const TITLE = 'Replay';

const HEADER_SUBLINE =
  'Record once, run it through any configuration. Runs of the same Recording ' +
  'are comparable by construction.';

const RECORD_NEW = 'Record new clip · max 1 min';
/**
 * Microphone capture lands with the Live view's recorder; until then the
 * affordance states the cap it will enforce rather than pretending to record.
 */
const RECORD_NEW_HINT = 'Microphone capture is not wired into Replay yet';

/**
 * Retained repetitions per (recording × configuration) cell — PRD §17 22c.
 * The warmup is an ADDITIONAL execution the batch runner discards, never one
 * of these five.
 */
const SWEEP_REPS = 5;

/* ---------------------------------------------------------------- styles -- */

const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-4)',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  flexWrap: 'wrap',
};

const columnsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '330px 1fr',
  gap: 'var(--space-4)',
  alignItems: 'start',
};

const recordButtonStyle: CSSProperties = {
  marginLeft: 'auto',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-card)',
  color: 'var(--text-secondary)',
  fontFamily: 'inherit',
  fontSize: 'var(--text-sm)',
  fontWeight: 'var(--weight-medium)',
  padding: 'var(--space-2) var(--space-3)',
  cursor: 'not-allowed',
};

/* ----------------------------------------------------------------- state -- */

/** A sweep in flight, plus the matrix it was started over. */
interface SweepState {
  handle: BatchHandle;
  configurations: BatchConfiguration[];
  reps: number;
  progress: BatchProgress | null;
}

function initialConfig(): ReplayConfigState {
  // Arm B's recipe by construction (PRD §17 23d): a default that derived to
  // 'ad-hoc' would turn every unconfigured run into an orphan.
  return {
    architecture: 'cascade',
    realtimeModel: REALTIME_MODEL,
    providers: { ...DEFAULT_CASCADE_TRIPLE },
  };
}

/** The sweep matrix: the frozen arms, named by the derivation that owns them. */
function sweepConfigurations(): BatchConfiguration[] {
  return ARMS.map((entry) => ({ id: entry.tag, label: entry.label, config: entry.config }));
}

/* ------------------------------------------------------------------ view -- */

export default function ReplayView(props: ReplayViewProps): ReactElement {
  const { deps } = props;

  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(null);
  const [config, setConfig] = useState<ReplayConfigState>(initialConfig);
  const [sweep, setSweep] = useState<SweepState | null>(null);

  const refreshRuns = useCallback(async (): Promise<void> => {
    setRuns(await deps.runs.list());
  }, [deps]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [loadedRecordings, loadedRuns] = await Promise.all([
        deps.recordings.list(),
        deps.runs.list(),
      ]);
      if (!live) return;
      setRecordings(loadedRecordings);
      setRuns(loadedRuns);
    })();
    return () => {
      live = false;
    };
  }, [deps]);

  /** Every Run, failed included — a failure is a Run like any other. */
  const runCounts: Record<string, number> = {};
  for (const run of runs) {
    runCounts[run.recordingId] = (runCounts[run.recordingId] ?? 0) + 1;
  }

  // A soft-deleted Recording leaves the library but stays reachable, so its
  // Runs keep a label and a duration to normalize their cost by.
  const visibleRecordings = recordings.filter((recording) => recording.deletedAt === undefined);
  const selectedRecording =
    recordings.find((recording) => recording.id === selectedRecordingId) ?? null;
  const selectedRuns = runs.filter((run) => run.recordingId === selectedRecordingId);

  const rename = (recordingId: string, label: string): void => {
    void deps.recordings.patchLabel(recordingId, label).then((next) => {
      setRecordings((previous) =>
        previous.map((recording) => (recording.id === recordingId ? next : recording)),
      );
    });
  };

  const remove = (recordingId: string): void => {
    void deps.recordings.remove(recordingId).then((next) => {
      setRecordings((previous) =>
        previous.map((recording) => (recording.id === recordingId ? next : recording)),
      );
    });
  };

  const run = (): void => {
    if (selectedRecordingId === null) return;
    void deps
      .runOnce({
        recordingId: selectedRecordingId,
        config: {
          architecture: config.architecture,
          realtimeModel: config.realtimeModel,
          providers: config.providers,
        },
      })
      .then((result) => {
        setRuns((previous) => [...previous, result.run]);
      });
  };

  const startSweep = (): void => {
    if (selectedRecordingId === null || sweep !== null) return;
    const configurations = sweepConfigurations();
    const handle = deps.startBatch({
      recordingIds: [selectedRecordingId],
      configurations,
      reps: SWEEP_REPS,
      onProgress: (progress) =>
        setSweep((previous) => (previous === null ? previous : { ...previous, progress })),
    });
    setSweep({ handle, configurations, reps: SWEEP_REPS, progress: null });
    // A cancelled sweep is a SHORT sweep: whatever completed is still listed.
    void handle.done.then(() => {
      setSweep(null);
      void refreshRuns();
    });
  };

  const batchProgress =
    sweep === null ? null : (
      <BatchProgressPanel
        progress={sweep.progress}
        configurations={sweep.configurations}
        reps={sweep.reps}
        onCancel={() => sweep.handle.cancel()}
      />
    );

  return (
    <div data-replay-view="" style={pageStyle}>
      <header style={headerStyle}>
        <h1
          style={{
            fontWeight: 'var(--weight-semibold)',
            fontSize: 'var(--text-lg)',
            letterSpacing: 'var(--tracking-heading)',
            margin: 0,
          }}
        >
          {TITLE}
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 0 }}>
          {HEADER_SUBLINE}
        </p>
        <button
          type="button"
          data-record-new=""
          disabled
          title={RECORD_NEW_HINT}
          style={recordButtonStyle}
        >
          {RECORD_NEW}
        </button>
      </header>

      <div style={columnsStyle}>
        <RecordingsLibrary
          recordings={visibleRecordings}
          runCounts={runCounts}
          selectedRecordingId={selectedRecordingId}
          onSelect={setSelectedRecordingId}
          onRename={rename}
          onDelete={remove}
        />

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
            minWidth: 0,
          }}
        >
          <RunConfigPanel
            recordingLabel={selectedRecording === null ? null : selectedRecording.label}
            config={config}
            onConfigChange={setConfig}
            onRun={run}
            onBatchSweep={startSweep}
            batchProgress={batchProgress}
          />

          <RunsList
            recording={selectedRecording}
            runs={selectedRuns}
            onPlay={(runId) => deps.playRun(runId)}
          />
        </div>
      </div>
    </div>
  );
}
