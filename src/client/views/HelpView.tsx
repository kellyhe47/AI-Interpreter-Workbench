/**
 * Ticket 016 — Help view: six plain-language cards.
 *
 * The reader this view is written for has never seen the PRD. Everything here
 * is copy from the design mock's Help section, reproduced verbatim rather than
 * paraphrased, because three of its sentences state rules the rest of the app
 * enforces silently and a paraphrase would quietly contradict the code:
 *
 *  1. THE THREE ENTITIES (card 2). A Recording is an input, a Run is one
 *     execution of a Recording through one configuration, a LiveSession is a
 *     real conversation's metrics — and LiveSessions and Runs are NEVER
 *     compared. The ledger enforces exactly that: runAggregates() never sees a
 *     LiveSession.
 *  2. THE TAG IS DERIVED (card 3). 'You never label a run yourself.' Nothing
 *     anywhere in this app sets an arm tag; membership is deriveArmTag() of
 *     what was actually configured. Help must not imply a label control that
 *     does not and must not exist.
 *  3. NOTHING POOLS (card 4). A Cantonese finding is never evidence about
 *     Spanish speed; the result screens keep the tracks apart, and this is
 *     where the app says why.
 *
 * PURE. No props, no deps, no clock, no state — and NO controls: Help
 * explains, it never acts. Rendering it twice produces identical text, which
 * is what makes it safe to mount and unmount on every tab switch.
 *
 * STYLING FROM TOKENS ONLY. No colour literal of any notation appears in this
 * file — the source guard in HelpView.test.tsx greps for all three — so the
 * mock's card shadow arrives as var(--shadow-card) rather than inline.
 *
 * DOM contract (locked by HelpView.test.tsx):
 *   [data-help-view] root, containing exactly six [data-help-card] elements,
 *   each with a [data-help-title]. Titles, in mock order:
 *     1. What we're researching        — the sealed box vs the assembly line
 *     2. Live vs Replay — the two modes (incl. the three-entity explainer)
 *     3. The three arms                — the derived-tag statement
 *     4. The experiments               — the four questions + the non-pooling rule
 *     5. How to use it                 — the four numbered steps
 *     6. How to read it                — p50/p95, cost slope, provenance, badges
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react';

/* ---------------------------------------------------------------- styles -- */

const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-4)',
  maxWidth: 760,
  width: '100%',
  margin: '0 auto',
};

const cardStyle: CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-lg)',
  padding: 'var(--space-5) 22px',
  boxShadow: 'var(--shadow-card)',
};

const titleStyle: CSSProperties = {
  fontWeight: 'var(--weight-semibold)',
  fontSize: 'var(--text-md)',
  margin: 0,
};

const bodyStyle: CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 'var(--text-base)',
  lineHeight: 1.7,
  marginTop: 'var(--space-2)',
};

const listStyle: CSSProperties = {
  ...bodyStyle,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
  marginTop: 10,
};

/** The mock's sunken callout — the box a load-bearing rule lives in. */
const calloutStyle: CSSProperties = {
  background: 'var(--surface-sunken)',
  borderRadius: 'var(--radius-md)',
  padding: '10px 13px',
  color: 'var(--text-secondary)',
  fontSize: 12.5,
  lineHeight: 1.6,
};

const armRowStyle: CSSProperties = {
  display: 'flex',
  gap: 'var(--space-3)',
  alignItems: 'flex-start',
};

const armPillStyle: CSSProperties = {
  flexShrink: 0,
  fontWeight: 'var(--weight-semibold)',
  fontSize: 'var(--text-sm)',
  background: 'var(--accent-soft)',
  color: 'var(--accent)',
  borderRadius: 'var(--radius-pill)',
  padding: '3px 10px',
};

/* ------------------------------------------------------------ primitives -- */

/** Emphasis inside body copy. Never a control — Help has no controls. */
function Term({ children }: { children: ReactNode }): ReactElement {
  return (
    <b style={{ color: 'var(--text-body)', fontWeight: 'var(--weight-semibold)' }}>{children}</b>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section data-help-card="" style={cardStyle}>
      <h2 data-help-title="" style={titleStyle}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ view -- */

export default function HelpView(): ReactElement {
  return (
    <div data-help-view="" style={pageStyle}>
      <header>
        <h1
          style={{
            fontWeight: 'var(--weight-semibold)',
            fontSize: 'var(--text-2xl)',
            letterSpacing: 'var(--tracking-heading)',
            margin: 0,
          }}
        >
          How this workbench works
        </h1>
        <p style={{ ...bodyStyle, marginTop: 3 }}>
          A plain-language guide to what we&apos;re testing, how to run it, and how to read the
          numbers.
        </p>
      </header>

      <Card title="What we're researching">
        <p style={bodyStyle}>
          There are two ways to build a live speech interpreter. One is a single AI model that
          listens in one language and speaks in another — one sealed box. The other is an assembly
          line: one service turns speech into text, another translates it, a third speaks the
          translation. The sealed box is simpler; the assembly line lets you swap any part. This
          workbench runs both on identical recorded input and measures which is faster, cheaper,
          better sounding, and easier to control — so the choice rests on data instead of vendor
          marketing.
        </p>
      </Card>

      <Card title="Live vs Replay — the two modes">
        <div style={listStyle}>
          <div>
            <Term>Live</Term> is a real interpreter: speak, hear the translation, up to five
            minutes, one architecture at a time. It&apos;s how you experience the product — and how
            conversation-length effects (creeping delay, rising cost) are measured. Its metrics are
            saved; its audio is discarded.
          </div>
          <div>
            <Term>Replay</Term> is the laboratory. Record a clip once (or use the built-in corpus),
            then run that exact same audio through any configuration you like. Because the input is
            identical every time, two runs are directly comparable — that&apos;s what makes the
            measurements trustworthy. Nothing in Replay ever autoplays; you listen on demand.
          </div>
          {/* The rule the ledger enforces: Runs and LiveSessions never pool. */}
          <div style={calloutStyle}>
            Three things to keep straight: a <Term>Recording</Term> is an input (what was said), a{' '}
            <Term>Run</Term> is one execution of a Recording through one configuration, and a{' '}
            <Term>LiveSession</Term> is a real conversation&apos;s metrics. Live sessions and Runs
            are never compared — different inputs, no shared basis.
          </div>
        </div>
      </Card>

      <Card title="The three arms">
        <p style={bodyStyle}>
          An &quot;arm&quot; is a named, frozen recipe. You never label a run yourself — the app
          derives the tag from what you actually configured. Assemble Arm B&apos;s exact recipe and
          your run <i>is</i> an Arm B run; deviate anywhere and it&apos;s tagged &quot;ad-hoc&quot;
          (explorable, but never counted as experimental evidence).
        </p>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            marginTop: 'var(--space-3)',
          }}
        >
          <div style={armRowStyle}>
            <span style={armPillStyle}>Arm A</span>
            <span style={{ ...bodyStyle, marginTop: 0 }}>
              <Term>Realtime</Term> — the sealed box. OpenAI&apos;s voice-to-voice model does
              everything internally. We can&apos;t see inside; we can only time the whole thing.
            </span>
          </div>
          <div style={armRowStyle}>
            <span style={armPillStyle}>Arm B</span>
            <span style={{ ...bodyStyle, marginTop: 0 }}>
              <Term>Cascade, all-OpenAI</Term> — the assembly line built entirely from OpenAI parts.
              A and B share a vendor, so any difference between them is caused by the design, not
              the company.
            </span>
          </div>
          <div style={armRowStyle}>
            <span style={armPillStyle}>Arm C</span>
            <span style={{ ...bodyStyle, marginTop: 0 }}>
              <Term>Cascade, one part swapped</Term> — identical to B except the voice stage, which
              uses ElevenLabs. Exactly one difference, so whatever changes between B and C is caused
              by that one swap.
            </span>
          </div>
        </div>
      </Card>

      <Card title="The experiments">
        <div style={listStyle}>
          <div>
            <Term>1 · Does the design itself cost speed?</Term> Arm A vs Arm B on the same
            recordings, same vendor. This is the headline result.
          </div>
          <div>
            <Term>2 · What does swapping one part buy?</Term> Arm B vs Arm C — only the voice stage
            differs, so the delta is cleanly attributable.
          </div>
          <div>
            <Term>3 · What happens over a long conversation?</Term> Measured in Live, not Replay.
            The sealed box re-reads the whole conversation on every turn, so its cost per minute
            climbs; the assembly line stays flat. A &quot;trimmed&quot; setting deletes history each
            turn to prove the slope comes from billing, not from voice-to-voice itself.
          </div>
          <div>
            <Term>4 · What about a less common language?</Term> Cantonese, as a case study against
            the same vendors. Realtime doesn&apos;t list it; we run it anyway to see <i>how</i> it
            fails — the transcript can look right while the audio is actually Mandarin. Only a
            native speaker&apos;s ear catches that, which is why blind scoring is playback-only.
          </div>
        </div>
        {/* Nothing pools: each result screen names its own question and data. */}
        <div style={{ ...calloutStyle, marginTop: 'var(--space-3)' }}>
          These tracks are never mixed: a Cantonese finding is never evidence about Spanish speed.
          Each result screen names its own question and its own data.
        </div>
      </Card>

      <Card title="How to use it">
        <div style={{ ...listStyle, gap: 10 }}>
          <div>
            <Term>1.</Term> In <Term>Live</Term>, press Start microphone and speak — the translation
            plays back automatically. Switch architecture or language mid-conversation; switches
            wait for your sentence to finish.
          </div>
          <div>
            <Term>2.</Term> In <Term>Replay</Term>, pick a Recording (or record a clip, up to a
            minute), choose an architecture — and for the cascade, a model for each of the three
            stages. The panel tells you live whether your recipe matches a named arm.
          </div>
          <div>
            <Term>3.</Term> Press <Term>Run</Term> to execute once, or <Term>Batch sweep</Term> to
            run a whole matrix unattended (~$4, ~68 minutes) — it shows progress and can be
            cancelled without losing completed runs.
          </div>
          <div>
            <Term>4.</Term> With two or more runs of the same Recording, use{' '}
            <Term>Compare blind</Term>: listen to both without knowing which is which, rate adequacy
            and fluency, then see the reveal. Scores go into the ledger.
          </div>
        </div>
      </Card>

      <Card title="How to read it">
        <div style={{ ...listStyle, gap: 10 }}>
          <div>
            <Term>The stage timings</Term> show where the time goes, in labelled milliseconds. The
            cascade shows all five steps; Realtime shows three, with its big middle one marked{' '}
            <i>opaque</i> — the sealed box. When something breaks, the cascade names the failed
            stage; Realtime can&apos;t. That difference is itself a finding.
          </div>
          <div>
            <Term>p50 / p95</Term> — the typical delay and the bad-day delay. Half of responses are
            faster than p50; 95% are faster than p95.
          </div>
          <div>
            <Term>Cost per minute</Term> — what a minute costs in provider fees. In Replay
            it&apos;s a snapshot; the conversation-length screen shows whether it climbs.
          </div>
          <div>
            <Term>Provenance lines</Term> — the small mono text under each title says exactly which
            recordings, how many repeats actually completed (&quot;4 of 5&quot;), and which settings
            produced the number. A number without that line is just a claim.
          </div>
          <div>
            <Term>&quot;Illustrative&quot; badges</Term> — a figure marked illustrative is a
            realistic placeholder, not a measurement. The real app shows &quot;No runs
            recorded&quot; until a sweep has actually run.
          </div>
        </div>
      </Card>
    </div>
  );
}
