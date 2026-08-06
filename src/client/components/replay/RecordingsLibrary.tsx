/**
 * Ticket 013 — Recordings library. See the DOM contract in ReplayView.tsx.
 *
 * THREE RULES THIS COMPONENT EXISTS TO HOLD
 *
 * 1. EMPTY IS GENUINELY EMPTY (PRD §8, §17 15g). With no Recordings the list
 *    renders [data-recordings-empty] and NOT ONE row. The design mock ships a
 *    placeholder library; a placeholder row here would be indistinguishable
 *    from a real clip an operator could select and measure.
 * 2. ONLY THE LABEL IS EDITABLE. A Recording is the fixed stimulus every Run
 *    of it is compared over, so audio, duration, language and origin have no
 *    control at all — the row renders them and nothing more. Committing a
 *    label goes through `onRename`, wired to recordings.patchLabel: the
 *    label-only endpoint, so no audio-bearing path is touched to rename.
 * 3. A DISALLOWED OPERATION HAS NO AFFORDANCE (PRD §17 25c). A corpus
 *    Recording renders NO delete control — not a disabled one, not one that
 *    explains itself after the click. Experiments depend on corpus clips, so
 *    the operation does not exist rather than failing late.
 *
 * Deletion is SOFT: the row disappears, the Recording's Runs do not. A Run
 * must always be able to reach the input that produced it.
 *
 * Ticket 020 — A FAILED LOAD MUST NOT BORROW THE EMPTY STATE (PRD §12).
 * A storage/load failure has to surface clearly, and "clearly" means
 * DISTINGUISHABLE FROM EMPTINESS. The two states answer different questions —
 * "nothing has been recorded yet" versus "the store could not be read" — and
 * they demand opposite next actions: record a clip, or fix the backend. When
 * the QA repro (proxy ECONNREFUSED → HTTP 500, empty body) rendered the
 * reassuring "No Recordings yet", an operator concluded the app was working
 * and simply empty. So the failure gets its OWN region, [data-recordings-error],
 * carrying the operator-readable failure, the underlying message and a retry —
 * and rule 1's empty state is NOT rendered beside it. Rendering both would
 * reproduce exactly the confusion the ticket exists to remove.
 */

import { useState, type CSSProperties, type ReactElement } from 'react';
import { ApiError } from '../../replay/recordingsClient';
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
  /**
   * The rejection the last recordings load ended in, or null when it
   * succeeded. NOT a boolean: the underlying message is part of what the
   * operator needs, and the ApiError's `code` is what the error region is
   * marked with.
   */
  loadError: unknown;
  /** Re-issues recordings.list(). Wired to the retry inside the error state. */
  onRetry: () => void;
}

/* ------------------------------------------------------------------ copy -- */

const TITLE = 'Recordings';

const EMPTY_TITLE = 'No Recordings yet';
const EMPTY_BODY =
  'Record a clip or load the corpus. Nothing is listed until a Recording ' +
  'exists — a sample row would be indistinguishable from one you could measure.';

/** The lifecycle rules, stated whether or not anything has been recorded. */
const FOOTER =
  'Labels are editable; audio is immutable. Deleting hides a Recording but keeps its Runs. ' +
  "Corpus Recordings can't be deleted — experiments depend on them.";

const EDIT_LABEL = 'Edit label';
const DELETE_RECORDING = 'Delete recording';
const LABEL_INPUT = 'Recording label';

/**
 * The failure copy. It names the thing that could not be done — read the
 * Recordings — and then, deliberately, says what an empty library would NOT
 * say: this is not emptiness. The underlying message follows verbatim; a
 * swallowed cause leaves the operator with nothing to act on.
 */
const ERROR_TITLE = "Couldn't load Recordings";
const ERROR_BODY =
  'The Recordings store could not be reached, so nothing can be listed. This is ' +
  'not an empty library — the library is unknown until the load succeeds.';
const ERROR_DETAIL_LABEL = 'reported:';
const RETRY = 'Retry';

/** Marker for a rejection that is not an ApiError and so carries no code. */
const UNTYPED_ERROR_CODE = 'load-failed';

/* ---------------------------------------------------------------- format -- */

/** M:SS — the library's duration column. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The marker the error region is tagged with. recordingsClient types every
 * failure (PRD §12), so an ApiError hands over its `code` directly; anything
 * else — `fetch` itself throwing, say — still gets a non-empty marker rather
 * than an empty attribute that reads as "no failure".
 */
function errorCode(cause: unknown): string {
  return cause instanceof ApiError ? cause.code : UNTYPED_ERROR_CODE;
}

/** The underlying message, surfaced rather than swallowed. */
function errorDetail(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  const rendered = String(cause);
  return rendered.length > 0 ? rendered : UNTYPED_ERROR_CODE;
}

/* ---------------------------------------------------------------- styles -- */

const panelStyle: CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-card)',
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  padding: 'var(--space-3) var(--space-4)',
  borderBottom: '1px solid var(--border-default)',
  fontWeight: 'var(--weight-semibold)',
  fontSize: 'var(--text-base)',
};

const footerStyle: CSSProperties = {
  padding: 'var(--space-3) var(--space-4)',
  borderTop: '1px solid var(--border-default)',
  color: 'var(--text-muted)',
  fontSize: 'var(--text-xs)',
  lineHeight: 'var(--leading-normal)',
};

const emptyStyle: CSSProperties = {
  padding: 'var(--space-6) var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-1)',
  textAlign: 'center',
};

/** Deliberately NOT emptyStyle: the two states must not look alike. */
const errorStyle: CSSProperties = {
  padding: 'var(--space-5) var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
  alignItems: 'flex-start',
  textAlign: 'left',
  background: 'var(--negative-soft)',
  borderBottom: '1px solid var(--border-default)',
};

const retryButtonStyle: CSSProperties = {
  border: '1px solid var(--negative)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-card)',
  color: 'var(--negative)',
  fontFamily: 'inherit',
  fontSize: 'var(--text-sm)',
  fontWeight: 'var(--weight-medium)',
  padding: 'var(--space-1) var(--space-3)',
  cursor: 'pointer',
};

const monoStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  color: 'var(--text-muted)',
};

function rowStyle(selected: boolean): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
    width: '100%',
    boxSizing: 'border-box',
    padding: 'var(--space-3) var(--space-4)',
    borderBottom: '1px solid var(--border-default)',
    background: selected ? 'var(--surface-selected)' : 'var(--surface-card)',
    cursor: 'pointer',
    textAlign: 'left',
  };
}

function originPillStyle(origin: Recording['origin']): CSSProperties {
  return {
    display: 'inline-block',
    borderRadius: 'var(--radius-pill)',
    padding: '0 var(--space-2)',
    fontSize: 'var(--text-xs)',
    fontWeight: 'var(--weight-medium)',
    background: origin === 'corpus' ? 'var(--accent-soft)' : 'var(--surface-sunken)',
    color: origin === 'corpus' ? 'var(--accent-strong)' : 'var(--text-secondary)',
  };
}

const iconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  padding: 0,
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--surface-card)',
  cursor: 'pointer',
};

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  font: 'inherit',
  fontSize: 'var(--text-sm)',
  color: 'var(--text-body)',
  padding: 'var(--space-1) var(--space-2)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--surface-card)',
};

/* ----------------------------------------------------------------- icons -- */

function PencilIcon(): ReactElement {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--gray-500)"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function TrashIcon(): ReactElement {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--gray-500)"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 14h10l1-14" />
    </svg>
  );
}

/* ------------------------------------------------------------ component -- */

export default function RecordingsLibrary(props: RecordingsLibraryProps): ReactElement {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  function beginEdit(recording: Recording): void {
    setEditingId(recording.id);
    setDraft(recording.label);
  }

  function commit(recordingId: string): void {
    const next = draft.trim();
    setEditingId(null);
    if (next.length > 0) props.onRename(recordingId, next);
  }

  // THREE-WAY, never two-and-a-half: failed, empty, listed. The failure branch
  // comes FIRST and excludes the other two — an error rendered beside "No
  // Recordings yet" is the ticket-020 confusion, not a fix for it.
  const failed = props.loadError !== null && props.loadError !== undefined;

  return (
    <div data-recordings-library="" style={panelStyle}>
      <div style={headerStyle}>{TITLE}</div>

      {failed ? (
        <div
          data-recordings-error=""
          data-error-code={errorCode(props.loadError)}
          role="alert"
          style={errorStyle}
        >
          <span style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}>
            {ERROR_TITLE}
          </span>
          <span
            style={{
              color: 'var(--text-secondary)',
              fontSize: 'var(--text-xs)',
              lineHeight: 'var(--leading-normal)',
            }}
          >
            {ERROR_BODY}
          </span>
          <span style={monoStyle}>
            {`${ERROR_DETAIL_LABEL} ${errorDetail(props.loadError)}`}
          </span>
          <button
            type="button"
            data-recordings-retry=""
            onClick={props.onRetry}
            style={retryButtonStyle}
          >
            {RETRY}
          </button>
        </div>
      ) : props.recordings.length === 0 ? (
        <div data-recordings-empty="" style={emptyStyle}>
          <span style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}>
            {EMPTY_TITLE}
          </span>
          <span
            style={{
              color: 'var(--text-secondary)',
              fontSize: 'var(--text-xs)',
              lineHeight: 'var(--leading-normal)',
            }}
          >
            {EMPTY_BODY}
          </span>
        </div>
      ) : (
        <div role="listbox" aria-label={TITLE}>
          {props.recordings.map((recording) => {
            const selected = recording.id === props.selectedRecordingId;
            const editing = recording.id === editingId;
            return (
              <div
                key={recording.id}
                data-recording-row=""
                data-recording={recording.id}
                data-origin={recording.origin}
                data-selected={selected ? 'true' : 'false'}
                role="option"
                aria-selected={selected}
                onClick={() => props.onSelect(recording.id)}
                style={rowStyle(selected)}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    minWidth: 0,
                  }}
                >
                  {editing ? (
                    <input
                      data-label-input=""
                      aria-label={LABEL_INPUT}
                      autoFocus
                      value={draft}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commit(recording.id);
                        if (event.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={() => setEditingId(null)}
                      style={inputStyle}
                    />
                  ) : (
                    <>
                      <span
                        data-recording-label=""
                        style={{
                          fontWeight: 'var(--weight-medium)',
                          fontSize: 'var(--text-sm)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {recording.label}
                      </span>
                      <span data-origin-pill="" style={originPillStyle(recording.origin)}>
                        {recording.origin}
                      </span>
                      <span style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-1)' }}>
                        <button
                          type="button"
                          data-edit-label=""
                          aria-label={EDIT_LABEL}
                          title={EDIT_LABEL}
                          onClick={(event) => {
                            event.stopPropagation();
                            beginEdit(recording);
                          }}
                          style={iconButtonStyle}
                        >
                          <PencilIcon />
                        </button>
                        {/* MIC ONLY. A corpus row renders no delete control at
                            all — disallowed, not warned about (PRD §17 25c). */}
                        {recording.origin === 'mic' ? (
                          <button
                            type="button"
                            data-delete-recording=""
                            aria-label={DELETE_RECORDING}
                            title={DELETE_RECORDING}
                            onClick={(event) => {
                              event.stopPropagation();
                              props.onDelete(recording.id);
                            }}
                            style={iconButtonStyle}
                          >
                            <TrashIcon />
                          </button>
                        ) : null}
                      </span>
                    </>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 'var(--space-3)', ...monoStyle }}>
                  <span data-recording-language="">{recording.sourceLanguage}</span>
                  <span data-recording-duration="">{formatDuration(recording.durationMs)}</span>
                  <span data-recording-run-count="">
                    {`${props.runCounts[recording.id] ?? 0} runs`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div data-library-footer="" style={footerStyle}>
        {FOOTER}
      </div>
    </div>
  );
}
