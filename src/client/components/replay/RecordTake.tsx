/**
 * Ticket 036 — the record-a-take flow behind [data-record-new] (PRD §7 step 1:
 * "Record a clip — maximum 1 minute. It is saved and appears in the UI").
 *
 * NOTHING IS GLOBAL, AND NOTHING HERE TOUCHES A MICROPHONE. `startTake`,
 * `segmentTake`, take playback, the clock, the id minter and the save seam all
 * arrive through props. This component constructs no AudioContext, calls no
 * getUserMedia and holds no ambient timer: the elapsed readout advances off the
 * capture seam's own level callback, so a take that is not producing audio
 * cannot show a clock that says it is.
 *
 * SEGMENTATION IS A SUGGESTION, NEVER THE RECORD. `segmentTake` fills the rows
 * once, at the moment the take freezes; from then on the operator owns every
 * boundary. Rows are editable, addable and removable, and the index is derived
 * from position so a removal renumbers 1..N rather than leaving a hole. A wrong
 * boundary mis-attributes every later category finding, so the VAD proposes and
 * the operator disposes.
 *
 * AN INVALID MANIFEST IS IMPOSSIBLE TO SUBMIT. The corpus save is gated by the
 * REAL validateManifest (src/core/corpus.ts) plus the two tagging rules, and it
 * states the reason it refuses. The server rejects the same manifest with a
 * 400; that 400 must never be the first the operator hears of it, because by
 * then the take is over and the room has moved on.
 *
 * ONE MIC-DENIAL COPY. The remediation is imported from
 * src/client/copy/micDenial.ts — the very text the Live view shows. A denial has
 * two independent causes and naming one sends half the operators in a circle.
 *
 * NOTHING AUTOPLAYS (PRD §7). The take sounds from [data-record-play] and from
 * nowhere else.
 *
 * ============================== DOM CONTRACT ==============================
 * Root [data-record-take][data-record-stage='armed'|'recording'|'review'|'denied']
 *
 * armed / recording:
 *   [data-record-cap-note]      CAP_NOTE, verbatim
 *   [data-record-elapsed]       'M:SS / 1:00'
 *   [data-record-level][data-level='0'..'5']   mic level, recording only
 *   [data-record-start]         button 'Start recording'   (armed)
 *   [data-record-stop]          button 'Stop recording'    (recording)
 *   [data-record-cancel]        button 'Cancel take'       (every stage)
 * review:
 *   [data-record-cap-reached]   CAP_REACHED — only when the cap stopped it
 *   [data-take-duration]        the take's length
 *   [data-record-play]          button 'Play take' -> playTake(take); a press
 *                               that cannot build an AudioContext is reported
 *                               through the host's funnel (ticket 049 R3-1)
 *   [data-take-label]           textbox 'Clip label'
 *   [data-take-language]        select 'Source language' — en | es | yue
 *   [data-segmentation-note]    SEGMENTATION_NOTE, verbatim
 *   [data-utterance-row][data-utterance-index=<1-based>], each holding
 *     [data-utterance-start]      number input 'Utterance {i} start (ms)'
 *     [data-utterance-end]        number input 'Utterance {i} speech end (ms)'
 *     [data-utterance-category]   select 'Utterance {i} category', one option
 *                                 per CORPUS_CATEGORIES plus an empty
 *                                 'untagged' placeholder
 *     [data-utterance-reference]  textbox 'Utterance {i} reference text' —
 *                                 EN/ES ONLY; ABSENT for yue
 *     [data-utterance-remove]     button 'Remove utterance {i}'
 *   [data-utterance-add]        button 'Add utterance'
 *   [data-reference-withheld]   REFERENCE_WITHHELD, yue only
 *   [data-save-corpus]          button 'Save as corpus clip'
 *   [data-save-adhoc]           button 'Save as ad-hoc clip'
 *   [data-save-blocked]         the reason the corpus save is refused — ABSENT
 *                               when nothing blocks it. The same text is
 *                               [data-save-corpus]'s `title` while it is
 *                               `disabled`.
 *   [data-record-save-error]    a rejected POST, so a failed save is visible
 *                               rather than a control that silently did nothing
 * denied:
 *   [data-record-denied]        the two-layer remediation, from the SHARED
 *                               src/client/copy/micDenial.ts constants.
 * ==========================================================================
 *
 * RE-TAGGING (the ticket's open question). A corpus Recording is NOT re-taggable
 * here: tagging happens once, before the clip exists, and the flow closes on
 * save. Retagging after Runs exist would silently rewrite what past samples
 * measured — the same class of harm as mutable audio (PRD §7: audio is
 * immutable) — so the manifest is frozen with the bytes it describes.
 */

import { useRef, useState, type CSSProperties, type ReactElement } from 'react';
import {
  CORPUS_CATEGORIES,
  validateManifest,
  type CorpusCategory,
  type CorpusUtterance,
} from '../../../core/corpus';
import { bytesToBase64 } from '../../audio/pcm';
import {
  MIC_DENIED_HEADING,
  MIC_DENIED_NO_REPROMPT,
  MIC_DENIED_OS_SETTING,
  MIC_DENIED_SITE_PERMISSION,
} from '../../copy/micDenial';
import {
  MAX_TAKE_MS,
  type CaptureDenied,
  type RecordedTake,
  type TakeRecorder,
} from '../../replay/capture';
import type { NewRecordingInput } from '../../replay/recordingsClient';
import type { SegmentedUtterance } from '../../replay/segment';
import type { ReplayDeps, ReplayTakeOptions } from '../../views/ReplayView';

export interface RecordTakeProps {
  /** Pre-bound capture seam; the browser bits belong to the host, not here. */
  startTake: (options: ReplayTakeOptions) => Promise<TakeRecorder | CaptureDenied>;
  /** Proposes the utterance boundaries the operator then confirms. */
  segmentTake: (samples: Int16Array) => SegmentedUtterance[];
  /**
   * On-demand playback of the recorded take. NEVER called at render.
   *
   * TICKET 049 R3-1 — the SECOND argument is not optional decoration: it is how
   * a press that could not build an AudioContext says so. Replay shares one
   * context per deps bag, so such a press is otherwise a silent no-op — and a
   * freshly recorded take has no "no audio stored" explanation available at
   * all, which makes it the most ambiguous silence on either screen. This prop
   * was previously narrowed to one argument, which quietly stranded the
   * reporter `buildReplayDeps().playTake` accepts.
   *
   * Typed as the SEAM ITSELF rather than a restatement of its shape, so this
   * prop cannot drift back out of step with `ReplayDeps['playTake']`.
   */
  playTake?: NonNullable<ReplayDeps['playTake']>;
  /** Provenance stamped onto a corpus save; absent hosts stamp nothing. */
  corpusVersion?: string;
  now: () => number;
  newId: () => string;
  /** Persists the take. Resolves once the Recording exists. */
  onSave: (input: NewRecordingInput) => Promise<void>;
  /** Abandons the flow — the panel unmounts and nothing is POSTed. */
  onClose: () => void;
}

/* ------------------------------------------------------------------ copy -- */

const TITLE = 'Record a clip';

/** The affordance states the cap it ENFORCES — ticket 035 clamps to MAX_TAKE_MS. */
const CAP_NOTE = 'Maximum 1 minute — the take stops itself at the cap.';

/** Shown only when the cap, not the operator, ended the take. */
const CAP_REACHED = 'Stopped at the 1 minute cap.';

const SEGMENTATION_NOTE = 'Segmentation is a suggestion — check every boundary before saving.';

const BLOCKED_CATEGORY =
  'Every utterance needs a category before this take can be saved as corpus.';

const BLOCKED_REFERENCE =
  'Every English or Spanish utterance needs its verbatim reference text — WER is scored against it.';

/** PRD §9: Cantonese is improvised, so there is no script to score WER against. */
const REFERENCE_WITHHELD =
  'Cantonese is improvised from English prompt cards — there is no written script, ' +
  'so no reference text and no WER.';

const START = 'Start recording';
const STOP = 'Stop recording';
const CANCEL = 'Cancel take';
const PLAY = 'Play take';
const ADD_UTTERANCE = 'Add utterance';
const SAVE_CORPUS = 'Save as corpus clip';
const SAVE_ADHOC = 'Save as ad-hoc clip';

const LABEL_FIELD = 'Clip label';
const LANGUAGE_FIELD = 'Source language';
const UNTAGGED = 'untagged';

/** A save must not be refused for want of a name the operator did not give. */
const DEFAULT_LABEL = 'untitled take';

const SAVE_FAILED = 'The clip was not saved:';

/* ------------------------------------------------------------- languages -- */

interface LanguageOption {
  code: string;
  label: string;
}

const LANGUAGES: readonly LanguageOption[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'yue', label: 'Cantonese' },
];

/** The languages a verbatim script exists for, and therefore WER (PRD §9). */
const REFERENCED_LANGUAGES: ReadonlySet<string> = new Set(['en', 'es']);

/* ----------------------------------------------------------------- state -- */

type Stage = 'armed' | 'recording' | 'review' | 'denied';

/**
 * One row under review. The boundaries are held as the TEXT the operator typed
 * — an input mid-edit is briefly not a number, and fighting that would eat
 * keystrokes — and are parsed where the manifest is built.
 */
interface DraftUtterance {
  id: string;
  startMs: string;
  endMs: string;
  /** '' until tagged; the empty option is the untagged placeholder. */
  category: string;
  referenceText: string;
}

/** Fallback span for a row the operator added by hand, in ms. */
const ADDED_UTTERANCE_MS = 1_000;

/* ---------------------------------------------------------------- styles -- */

const cardStyle: CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-card)',
  padding: 'var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
};

const headRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  flexWrap: 'wrap',
};

const noteStyle: CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 'var(--text-sm)',
  lineHeight: 'var(--leading-normal)',
  margin: 0,
};

const monoStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-sm)',
  color: 'var(--text-body)',
};

const buttonStyle: CSSProperties = {
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-card)',
  color: 'var(--text-body)',
  fontFamily: 'inherit',
  fontSize: 'var(--text-sm)',
  fontWeight: 'var(--weight-medium)',
  padding: 'var(--space-2) var(--space-3)',
  cursor: 'pointer',
};

const smallButtonStyle: CSSProperties = {
  ...buttonStyle,
  padding: 'var(--space-1) var(--space-2)',
  fontSize: 'var(--text-xs)',
};

function primaryStyle(enabled: boolean): CSSProperties {
  return {
    border: 'none',
    borderRadius: 'var(--radius-md)',
    background: enabled ? 'var(--btn-primary-bg)' : 'var(--surface-sunken)',
    color: enabled ? 'var(--text-inverse)' : 'var(--text-muted)',
    fontFamily: 'inherit',
    fontSize: 'var(--text-sm)',
    fontWeight: 'var(--weight-medium)',
    padding: 'var(--space-2) var(--space-4)',
    cursor: enabled ? 'pointer' : 'not-allowed',
  };
}

const inputStyle: CSSProperties = {
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--surface-card)',
  color: 'var(--text-body)',
  fontFamily: 'inherit',
  fontSize: 'var(--text-sm)',
  padding: 'var(--space-1) var(--space-2)',
  minWidth: 0,
};

const numberInputStyle: CSSProperties = { ...inputStyle, width: 'var(--space-12)' };

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  flexWrap: 'wrap',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-2)',
};

const blockedStyle: CSSProperties = {
  color: 'var(--negative)',
  fontSize: 'var(--text-sm)',
  lineHeight: 'var(--leading-normal)',
  margin: 0,
};

const levelBarStyle = (lit: boolean): CSSProperties => ({
  width: 'var(--space-1)',
  height: 'var(--space-3)',
  borderRadius: 'var(--radius-sm)',
  background: lit ? 'var(--accent)' : 'var(--surface-sunken)',
});

/* ------------------------------------------------------------- utilities -- */

/** 'M:SS' — the shape the elapsed readout and the take duration both use. */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function draftFromSegment(segment: SegmentedUtterance, id: string): DraftUtterance {
  return {
    id,
    startMs: String(segment.startMs),
    endMs: String(segment.trueSpeechEndMs),
    category: '',
    referenceText: '',
  };
}

/* ------------------------------------------------------------ component -- */

export default function RecordTake(props: RecordTakeProps): ReactElement {
  const { startTake, segmentTake, playTake, corpusVersion, now, newId, onSave, onClose } = props;

  const [stage, setStage] = useState<Stage>('armed');
  const [level, setLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [take, setTake] = useState<RecordedTake | null>(null);
  const [cappedOut, setCappedOut] = useState(false);
  const [label, setLabel] = useState('');
  const [language, setLanguage] = useState(LANGUAGES[0]!.code);
  const [drafts, setDrafts] = useState<DraftUtterance[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const recorderRef = useRef<TakeRecorder | null>(null);
  /** The take is frozen exactly once; the cap and Stop race, and one wins. */
  const settledRef = useRef(false);
  const startingRef = useRef(false);

  /** Every path out of `recording` funnels through here. */
  const settle = (recorded: RecordedTake, byCap: boolean): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    recorderRef.current = null;
    setTake(recorded);
    setCappedOut(byCap);
    setDrafts(segmentTake(recorded.samples).map((s) => draftFromSegment(s, newId())));
    setStage('review');
  };

  const start = async (): Promise<void> => {
    if (startingRef.current) return;
    startingRef.current = true;
    const startedAt = now();
    const result = await startTake({
      // The elapsed readout rides the capture seam's own level callback rather
      // than an ambient timer: no clock ticks unless audio is arriving.
      onLevel: (bars) => {
        setLevel(bars);
        setElapsedMs(now() - startedAt);
      },
      onMaxDuration: (recorded) => settle(recorded, true),
      maxDurationMs: MAX_TAKE_MS,
    });
    startingRef.current = false;
    if ('status' in result) {
      setStage('denied');
      return;
    }
    recorderRef.current = result;
    setStage('recording');
  };

  const stop = async (): Promise<void> => {
    const recorder = recorderRef.current;
    if (recorder === null) return;
    settle(await recorder.stop(), false);
  };

  const cancel = (): void => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    onClose();
  };

  /* ------------------------------------------------------------ tagging -- */

  const referenced = REFERENCED_LANGUAGES.has(language);

  const patch = (index: number, change: Partial<DraftUtterance>): void => {
    setDrafts((previous) =>
      previous.map((draft, position) => (position === index ? { ...draft, ...change } : draft)),
    );
  };

  const removeUtterance = (index: number): void => {
    // The index is DERIVED from position, so a removal renumbers 1..N by
    // construction — validateManifest's contiguity rule cannot be broken here.
    setDrafts((previous) => previous.filter((_draft, position) => position !== index));
  };

  const addUtterance = (): void => {
    setDrafts((previous) => {
      const last = previous[previous.length - 1];
      const from = last === undefined ? 0 : Number(last.endMs);
      const start = Number.isFinite(from) ? from : 0;
      const ceiling = take === null ? start + ADDED_UTTERANCE_MS : take.durationMs;
      return [
        ...previous,
        {
          id: newId(),
          startMs: String(start),
          endMs: String(Math.min(start + ADDED_UTTERANCE_MS, ceiling)),
          category: '',
          referenceText: '',
        },
      ];
    });
  };

  /** The manifest as it stands — index derived from position, 1-based. */
  const manifest: CorpusUtterance[] = drafts.map((draft, position) => {
    const utterance: CorpusUtterance = {
      id: draft.id,
      index: position + 1,
      category: draft.category as CorpusCategory,
      trueSpeechEndMs: Number(draft.endMs),
    };
    // The KEY is absent for Cantonese, not empty: there is no script (PRD §9).
    if (referenced && draft.referenceText.trim().length > 0) {
      utterance.referenceText = draft.referenceText.trim();
    }
    return utterance;
  });

  /**
   * Why a corpus save is refused, or null. The two tagging rules come first
   * because they are what the operator can act on; validateManifest's own
   * reason — the server's reason, quoted before the server ever sees it — is
   * the last word.
   */
  const blocked: string | null =
    take === null ? 'no take to save'
    : drafts.some((draft) => draft.category === '') ? BLOCKED_CATEGORY
    : referenced && drafts.some((draft) => draft.referenceText.trim().length === 0) ?
      BLOCKED_REFERENCE
    : validateManifest(manifest, take.durationMs);

  /* ------------------------------------------------------------- saving -- */

  const submit = async (input: NewRecordingInput): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(input);
    } catch (cause: unknown) {
      setSaving(false);
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** Common half of both saves: the bytes, the name and the clock. */
  const baseInput = (recorded: RecordedTake, speechEndMs: number): NewRecordingInput => ({
    label: label.trim().length > 0 ? label.trim() : DEFAULT_LABEL,
    sourceLanguage: language,
    durationMs: recorded.durationMs,
    speechEndMs,
    origin: 'mic',
    createdAt: now(),
    audioBase64: bytesToBase64(recorded.wav),
  });

  const saveCorpus = (): void => {
    if (take === null || blocked !== null) return;
    // t0 is the LAST utterance's frozen speech end (PRD §8), not a per-run guess.
    const input: NewRecordingInput = {
      ...baseInput(take, manifest[manifest.length - 1]!.trueSpeechEndMs),
      origin: 'corpus',
      utterances: manifest,
    };
    if (corpusVersion !== undefined) input.corpusVersion = corpusVersion;
    void submit(input);
  };

  const saveAdhoc = (): void => {
    if (take === null) return;
    const last = drafts[drafts.length - 1];
    const end = last === undefined ? Number.NaN : Number(last.endMs);
    // NO `utterances` key and NO corpusVersion: an ad-hoc clip carries no
    // manifest at all, and an empty array would read as a corpus take with
    // none — which the server rejects and the ledger mis-reports.
    void submit(baseInput(take, Number.isFinite(end) ? end : take.durationMs));
  };

  /* ------------------------------------------------------------ render -- */

  const levelMeter = (
    <span
      data-record-level=""
      data-level={String(level)}
      aria-hidden
      style={{ display: 'inline-flex', gap: 'var(--space-1)', alignItems: 'flex-end' }}
    >
      {[1, 2, 3, 4, 5].map((bar) => (
        <span key={bar} style={levelBarStyle(bar <= level)} />
      ))}
    </span>
  );

  const cancelButton = (
    <button type="button" data-record-cancel="" onClick={cancel} style={buttonStyle}>
      {CANCEL}
    </button>
  );

  return (
    <div data-record-take="" data-record-stage={stage} style={cardStyle}>
      <div style={headRowStyle}>
        <span style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-base)' }}>
          {TITLE}
        </span>
      </div>

      {stage === 'armed' || stage === 'recording' ? (
        <>
          <p data-record-cap-note="" style={noteStyle}>
            {CAP_NOTE}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <span data-record-elapsed="" style={monoStyle}>
              {`${clock(elapsedMs)} / ${clock(MAX_TAKE_MS)}`}
            </span>
            {stage === 'recording' ? levelMeter : null}
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            {stage === 'armed' ? (
              <button
                type="button"
                data-record-start=""
                onClick={() => {
                  void start();
                }}
                style={primaryStyle(true)}
              >
                {START}
              </button>
            ) : (
              <button
                type="button"
                data-record-stop=""
                onClick={() => {
                  void stop();
                }}
                style={primaryStyle(true)}
              >
                {STOP}
              </button>
            )}
            {cancelButton}
          </div>
        </>
      ) : null}

      {stage === 'denied' ? (
        <>
          <div
            data-record-denied=""
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
          >
            <span
              style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-sm)' }}
            >
              {MIC_DENIED_HEADING}
            </span>
            <p style={noteStyle}>{MIC_DENIED_SITE_PERMISSION}</p>
            <p style={noteStyle}>{MIC_DENIED_OS_SETTING}</p>
            <p style={noteStyle}>{MIC_DENIED_NO_REPROMPT}</p>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>{cancelButton}</div>
        </>
      ) : null}

      {stage === 'review' && take !== null ? (
        <>
          {cappedOut ? (
            <p data-record-cap-reached="" style={noteStyle}>
              {CAP_REACHED}
            </p>
          ) : null}

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <span data-take-duration="" style={monoStyle}>
              {clock(take.durationMs)}
            </span>
            <button
              type="button"
              data-record-play=""
              onClick={() => playTake?.(take)}
              style={buttonStyle}
            >
              {PLAY}
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <input
              data-take-label=""
              type="text"
              aria-label={LABEL_FIELD}
              placeholder={LABEL_FIELD}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              style={{ ...inputStyle, flex: 1 }}
            />
            <select
              data-take-language=""
              aria-label={LANGUAGE_FIELD}
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              style={inputStyle}
            >
              {LANGUAGES.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <p data-segmentation-note="" style={noteStyle}>
            {SEGMENTATION_NOTE}
          </p>

          {referenced ? null : (
            <p data-reference-withheld="" style={noteStyle}>
              {REFERENCE_WITHHELD}
            </p>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {drafts.map((draft, position) => {
              const index = position + 1;
              return (
                <div
                  key={draft.id}
                  data-utterance-row=""
                  data-utterance-index={String(index)}
                  style={rowStyle}
                >
                  <input
                    data-utterance-start=""
                    type="number"
                    aria-label={`Utterance ${index} start (ms)`}
                    value={draft.startMs}
                    onChange={(event) => patch(position, { startMs: event.target.value })}
                    style={numberInputStyle}
                  />
                  <input
                    data-utterance-end=""
                    type="number"
                    aria-label={`Utterance ${index} speech end (ms)`}
                    value={draft.endMs}
                    onChange={(event) => patch(position, { endMs: event.target.value })}
                    style={numberInputStyle}
                  />
                  <select
                    data-utterance-category=""
                    aria-label={`Utterance ${index} category`}
                    value={draft.category}
                    onChange={(event) => patch(position, { category: event.target.value })}
                    style={inputStyle}
                  >
                    <option value="">{UNTAGGED}</option>
                    {CORPUS_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                  {referenced ? (
                    <input
                      data-utterance-reference=""
                      type="text"
                      aria-label={`Utterance ${index} reference text`}
                      value={draft.referenceText}
                      onChange={(event) => patch(position, { referenceText: event.target.value })}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                  ) : null}
                  <button
                    type="button"
                    data-utterance-remove=""
                    onClick={() => removeUtterance(position)}
                    style={smallButtonStyle}
                  >
                    {`Remove utterance ${index}`}
                  </button>
                </div>
              );
            })}
          </div>

          <div>
            <button
              type="button"
              data-utterance-add=""
              onClick={addUtterance}
              style={smallButtonStyle}
            >
              {ADD_UTTERANCE}
            </button>
          </div>

          {blocked === null ? null : (
            <p data-save-blocked="" style={blockedStyle}>
              {blocked}
            </p>
          )}

          {saveError === null ? null : (
            <p data-record-save-error="" style={blockedStyle}>
              {`${SAVE_FAILED} ${saveError}`}
            </p>
          )}

          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <button
              type="button"
              data-save-corpus=""
              disabled={blocked !== null || saving}
              title={blocked ?? undefined}
              onClick={saveCorpus}
              style={primaryStyle(blocked === null && !saving)}
            >
              {SAVE_CORPUS}
            </button>
            <button
              type="button"
              data-save-adhoc=""
              disabled={saving}
              onClick={saveAdhoc}
              style={buttonStyle}
            >
              {SAVE_ADHOC}
            </button>
            {cancelButton}
          </div>
        </>
      ) : null}
    </div>
  );
}
