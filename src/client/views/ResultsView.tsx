/**
 * Ticket 013 — Results view.
 *
 * `<ResultsView ledger={runLedger} />` — pure-props component (no context).
 * ALL figures come from deriveResultsModel(ledger) in
 * src/client/components/results/derive.ts; this component renders that
 * model verbatim and never computes or hardcodes a number. No sample /
 * fixture figure ever appears in the DOM.
 *
 * DOM contract (locked by ResultsView.test.tsx):
 *
 * - Header, always rendered: title 'Results' (600 22px) + subline
 *   'Four questions, one run ledger. Every figure carries its provenance;
 *   nothing here comes from a fixture run.'
 *   There is NO 'show recorded runs' switch — visibility derives from
 *   ledger.hasRuns.
 * - EMPTY STATE (!model.hasRuns — also a fixture/placeholder-only ledger):
 *   centered card with a chart glyph, 'No runs recorded' (600 14px),
 *   subline 'Run a benchmark sweep to populate experiment 1. Result cards
 *   never show sample data as evidence.', and a disabled 'Run sweep' button
 *   whose title/aria-label explain that sweeps need the real corpus.
 *   NONE of the four question cards is in the DOM, and the run-ledger table
 *   is absent too. No sample figures anywhere.
 * - WHEN hasRuns: four question cards (uppercase 10.5px tracked eyebrow,
 *   17px 600 title, mono 11px provenance line, metric grid, gray takeaway
 *   note in a sunken box):
 *     1. 'Track 1 of 3 · vendor held constant' /
 *        'Does the architecture itself cost latency?' — always rendered
 *        (exp1 model), columns realtime vs cascade·OpenAI vs delta.
 *     2. 'Track 2 of 3 · architecture held constant' /
 *        'What does swapping providers buy?' — metric grid only when
 *        model.exp2 exists, else its own empty note
 *        'no provider-swap runs recorded'.
 *     3. 'Track 1 · extended along time' /
 *        'What changes as the conversation continues?' — data only when
 *        model.stability exists, else 'no stability runs recorded'.
 *     4. 'Track 3 of 3 · exploratory case study' /
 *        'What does provider choice actually let us reach?' — coverage
 *        matrix only when model.coverage exists, else
 *        'no coverage observations recorded'.
 * - Run ledger table card, rendered whenever ANY real runs exist: title
 *   'Run ledger', subline 'One append-only ledger beneath every view. A
 *   metric cannot drift between screens or between a screen and the
 *   write-up.', grid header run id / experiment / configuration / pair /
 *   N / date, one row per run.
 * - Test hooks (style-agnostic, asserted instead of CSS classes):
 *     data-metric="<slug>"        on each metric-grid row (p50, p95, cost,
 *                                 wer, adequacy, fluency, intervals)
 *     data-tone="good|bad|neutral" on the row's delta cell (positive=green,
 *                                 negative=red, muted=gray styling keys off
 *                                 this attribute)
 *     data-provenance="exp1|exp2" on the mono provenance line of cards 1–2
 *     data-run-row                on each run-ledger table row
 *     data-mono                   on the mono run-id cell inside a run row
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import {
  deriveResultsModel,
  type ComparisonCardModel,
  type Tone,
} from '../components/results/derive';
import type { RunLedger } from '../state/ledger';

export interface ResultsViewProps {
  ledger: RunLedger;
}

const cardStyle: CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 12,
  boxShadow: '0 1px 2px rgba(0,0,0,.05)',
  padding: '20px 22px',
};

const eyebrowStyle: CSSProperties = {
  fontWeight: 500,
  fontSize: '10.5px',
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  color: 'var(--text-muted)',
  marginBottom: 6,
};

const titleStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: 17,
  letterSpacing: '-0.01em',
  margin: 0,
};

const provenanceStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--text-muted)',
  margin: '8px 0 0',
};

const gridRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.3fr 1fr 1fr .9fr',
  borderTop: '1px solid var(--border-default)',
};

const cellStyle: CSSProperties = { padding: '9px 0' };

const takeawayStyle: CSSProperties = {
  background: 'var(--surface-sunken)',
  borderRadius: 8,
  padding: '10px 13px 12.5px',
  color: 'var(--text-secondary)',
  fontSize: 12,
  marginTop: 14,
};

const emptyNoteStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 12,
  marginTop: 14,
};

const toneColor: { [tone in Tone]: string } = {
  good: 'var(--positive)',
  bad: 'var(--negative)',
  neutral: 'var(--text-muted)',
};

function QuestionCard(props: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section style={cardStyle}>
      <div style={eyebrowStyle}>{props.eyebrow}</div>
      <h2 style={titleStyle}>{props.title}</h2>
      {props.children}
    </section>
  );
}

function MetricGrid(props: {
  card: ComparisonCardModel;
  provenanceKey: 'exp1' | 'exp2';
}): ReactElement {
  const { card } = props;
  return (
    <div>
      <p data-provenance={props.provenanceKey} style={provenanceStyle}>
        {card.provenance}
      </p>
      <div style={{ marginTop: 12 }}>
        <div
          style={{
            ...gridRowStyle,
            borderTop: 'none',
            fontWeight: 500,
            fontSize: '10.5px',
            textTransform: 'uppercase',
            letterSpacing: '.05em',
            color: 'var(--text-muted)',
          }}
        >
          <div style={cellStyle}>metric</div>
          <div style={cellStyle}>{card.armA}</div>
          <div style={cellStyle}>{card.armB}</div>
          <div style={cellStyle}>delta</div>
        </div>
        {card.rows.map((row) => (
          <div key={row.metric} data-metric={row.metric} style={gridRowStyle}>
            <div style={{ ...cellStyle, color: 'var(--text-secondary)' }}>{row.label}</div>
            <div style={cellStyle}>{row.valueA}</div>
            <div style={cellStyle}>{row.valueB}</div>
            <div style={cellStyle}>
              <span data-tone={row.deltaTone} style={{ color: toneColor[row.deltaTone] }}>
                {row.delta}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState(): ReactElement {
  return (
    <div
      style={{
        ...cardStyle,
        padding: '56px 24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 8,
      }}
    >
      <svg
        width="26"
        height="26"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--gray-400)"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <path d="M3 3v18h18"></path>
        <circle cx="9" cy="13" r="1.2"></circle>
        <circle cx="13" cy="9" r="1.2"></circle>
        <circle cx="17" cy="12" r="1.2"></circle>
      </svg>
      <div style={{ fontWeight: 600, fontSize: 14, marginTop: 6 }}>No runs recorded</div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 12, maxWidth: 420, margin: 0 }}>
        Run a benchmark sweep to populate experiment 1. Result cards never show sample data
        as evidence.
      </p>
      <button
        type="button"
        disabled
        title="Sweeps require the real corpus to be loaded"
        style={{
          marginTop: 10,
          padding: '7px 14px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-default)',
          background: 'var(--surface-sunken)',
          color: 'var(--text-muted)',
          fontSize: 12,
          fontWeight: 500,
          cursor: 'not-allowed',
        }}
      >
        Run sweep
      </button>
    </div>
  );
}

const ledgerHeaders = ['run id', 'experiment', 'configuration', 'pair', 'N', 'date'] as const;

const ledgerGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.3fr 1fr 1.4fr .8fr .5fr .9fr',
  borderTop: '1px solid var(--border-default)',
};

export default function ResultsView(props: ResultsViewProps): ReactElement {
  const model = deriveResultsModel(props.ledger);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <h1 style={{ fontWeight: 600, fontSize: 22, letterSpacing: '-0.01em', margin: 0 }}>
          Results
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '6px 0 0' }}>
          Four questions, one run ledger. Every figure carries its provenance; nothing here
          comes from a fixture run.
        </p>
      </header>

      {!model.hasRuns ? (
        <EmptyState />
      ) : (
        <>
          <QuestionCard
            eyebrow="Track 1 of 3 · vendor held constant"
            title="Does the architecture itself cost latency?"
          >
            {model.exp1 ? (
              <>
                <MetricGrid card={model.exp1} provenanceKey="exp1" />
                <div style={takeawayStyle}>
                  Perceived latency, cost and observability compared arm-for-arm within a
                  single benchmark run; every figure above traces to the run ledger.
                </div>
              </>
            ) : (
              <div style={emptyNoteStyle}>no benchmark runs recorded</div>
            )}
          </QuestionCard>

          <QuestionCard
            eyebrow="Track 2 of 3 · architecture held constant"
            title="What does swapping providers buy?"
          >
            {model.exp2 ? (
              <>
                <MetricGrid card={model.exp2} provenanceKey="exp2" />
                <div style={takeawayStyle}>
                  Provider swaps are compared within their own run and never pooled with
                  track 1.
                </div>
              </>
            ) : (
              <div style={emptyNoteStyle}>no provider-swap runs recorded</div>
            )}
          </QuestionCard>

          <QuestionCard
            eyebrow="Track 1 · extended along time"
            title="What changes as the conversation continues?"
          >
            {model.stability ? (
              <div style={{ ...provenanceStyle, marginTop: 12 }}>
                {model.stability.count} utterances recorded · run {model.stability.runId}
              </div>
            ) : (
              <div style={emptyNoteStyle}>no stability runs recorded</div>
            )}
          </QuestionCard>

          <QuestionCard
            eyebrow="Track 3 of 3 · exploratory case study"
            title="What does provider choice actually let us reach?"
          >
            {model.coverage ? (
              <div style={{ marginTop: 12 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `1.3fr repeat(${model.coverage.arms.length}, 1fr)`,
                    fontWeight: 500,
                    fontSize: '10.5px',
                    textTransform: 'uppercase',
                    letterSpacing: '.05em',
                    color: 'var(--text-muted)',
                  }}
                >
                  <div style={cellStyle}>stage</div>
                  {model.coverage.arms.map((arm) => (
                    <div key={arm} style={cellStyle}>
                      {arm}
                    </div>
                  ))}
                </div>
                {model.coverage.stages.map((stage) => (
                  <div
                    key={stage}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: `1.3fr repeat(${model.coverage!.arms.length}, 1fr)`,
                      borderTop: '1px solid var(--border-default)',
                    }}
                  >
                    <div style={{ ...cellStyle, color: 'var(--text-secondary)' }}>{stage}</div>
                    {model.coverage!.arms.map((arm) => (
                      <div key={arm} style={cellStyle}>
                        {model.coverage!.counts[stage]?.[arm] ?? 0}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <div style={emptyNoteStyle}>no coverage observations recorded</div>
            )}
          </QuestionCard>

          <section style={cardStyle}>
            <h2 style={titleStyle}>Run ledger</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '6px 0 0' }}>
              One append-only ledger beneath every view. A metric cannot drift between
              screens or between a screen and the write-up.
            </p>
            <div style={{ marginTop: 12 }}>
              <div
                style={{
                  ...ledgerGridStyle,
                  borderTop: 'none',
                  fontWeight: 500,
                  fontSize: '10.5px',
                  textTransform: 'uppercase',
                  letterSpacing: '.05em',
                  color: 'var(--text-muted)',
                }}
              >
                {ledgerHeaders.map((header) => (
                  <div key={header} style={cellStyle}>
                    {header}
                  </div>
                ))}
              </div>
              {model.ledgerRows.map((row) => (
                <div key={row.runId} data-run-row style={ledgerGridStyle}>
                  <div style={cellStyle}>
                    <span data-mono style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                      {row.runId}
                    </span>
                  </div>
                  <div style={cellStyle}>{row.experiment}</div>
                  <div style={cellStyle}>{row.configuration}</div>
                  <div style={cellStyle}>{row.pair}</div>
                  <div style={cellStyle}>{row.n}</div>
                  <div style={cellStyle}>{row.date}</div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
