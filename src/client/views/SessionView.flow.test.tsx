/**
 * Ticket 012 — Session view flow tests: arm cards from fixture scripts,
 * failures, live transcripts, reconnect, stop summary, ledger-backed footer
 * (ACs 6–10).
 *
 * All suites here drive FixtureTransport scripts under vi.useFakeTimers();
 * see sessionTestKit.ts for the shared script/deps helpers.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FixtureScriptEvent } from '../transport/fixture';
import {
  COPY,
  SRC_FINAL,
  SRC_PARTIAL_1,
  SRC_PARTIAL_2,
  TGT_FINAL,
  advance,
  armCard,
  cascadeUtteranceScript,
  clickStartMicrophone,
  connLabel,
  realtimeUtteranceScript,
  renderApp,
  sessionFooter,
  sourceCard,
  stageRow,
} from './sessionTestKit';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Ticket 017 flipped the DEFAULT mode to realtime, so cascade-arm flows pin
// their session shape explicitly.
const CASCADE_SESSION = { mode: 'cascade' as const, arms: ['cascade-openai'] };

describe('AC6 — arm cards driven by the fixture script', () => {
  it('cascade card: in-flight bar, then ready with text, play + duration, labelled stage ms, footer', async () => {
    renderApp({
      initialState: CASCADE_SESSION,
      scripts: { 'cascade-openai': cascadeUtteranceScript() },
    });
    await clickStartMicrophone();

    // First source partial arrived → utterance in flight.
    await advance(50);
    const inFlight = armCard('cascade-openai');
    expect(inFlight).toHaveAttribute('data-arm-status', 'in-flight');
    expect(inFlight.querySelector('[data-inflight-bar]')).not.toBeNull();

    // Utterance completes.
    await advance(1200);
    const card = armCard('cascade-openai');
    expect(card).toHaveAttribute('data-arm-status', 'ready');
    expect(card).toHaveTextContent(TGT_FINAL);

    const play = within(card).getByRole('button', { name: /^play/ });
    expect(play).toHaveTextContent('2.1 s');

    // Per-stage rows with LABELLED mono milliseconds (bars alone don't satisfy).
    const stages: Array<[string, string]> = [
      ['endpointing', '500 ms'],
      ['stt', '42 ms'],
      ['mt', '298 ms'],
      ['tts', '201 ms'],
      ['queue', '12 ms'],
    ];
    for (const [label, ms] of stages) {
      const row = stageRow(card, label);
      expect(row, `stage row ${label}`).not.toBeNull();
      expect(row).toHaveTextContent(label);
      expect(row).toHaveTextContent(ms);
    }

    // Footer: total + cost + intervals note; no opaque footnote on cascade.
    expect(card).toHaveTextContent('total');
    expect(card).toHaveTextContent('1053 ms');
    expect(card).toHaveTextContent('$0.021/min');
    expect(card).toHaveTextContent('5 intervals · all visible');
    expect(card).not.toHaveTextContent('model interval is opaque');
  });

  it('realtime card: 3 labelled rows, opaque intervals note + opaque footnote', async () => {
    renderApp({
      initialState: { mode: 'realtime', arms: ['realtime'] },
      scripts: { realtime: realtimeUtteranceScript() },
    });
    await clickStartMicrophone();
    await advance(1100);

    const card = armCard('realtime');
    expect(card).toHaveAttribute('data-arm-status', 'ready');

    const stages: Array<[string, string]> = [
      ['endpointing', '500 ms'],
      ['model', '471 ms'],
      ['queue', '9 ms'],
    ];
    for (const [label, ms] of stages) {
      const row = stageRow(card, label);
      expect(row, `stage row ${label}`).not.toBeNull();
      expect(row).toHaveTextContent(ms);
    }
    // No cascade-only rows on a realtime card.
    expect(stageRow(card, 'stt')).toBeNull();
    expect(stageRow(card, 'mt')).toBeNull();
    expect(stageRow(card, 'tts')).toBeNull();

    expect(card).toHaveTextContent('total');
    expect(card).toHaveTextContent('980 ms');
    expect(card).toHaveTextContent('$0.140/min');
    expect(card).toHaveTextContent('3 intervals · 1 opaque');
    expect(card).toHaveTextContent(COPY.opaqueFootnote);
  });
});

describe('AC7 — failed arm keeps the session running', () => {
  it('cascade failure names the stage verbatim; status strip stays alive', async () => {
    const script: FixtureScriptEvent[] = [
      { at: 10, type: 'sourceText', kind: 'partial', text: SRC_PARTIAL_1, utt: 0 },
      {
        at: 300,
        type: 'error',
        message: 'mt stage timed out for this utterance',
        opaque: false,
        stage: 'mt',
      },
    ];
    renderApp({ initialState: CASCADE_SESSION, scripts: { 'cascade-openai': script } });
    await clickStartMicrophone();
    await advance(400);

    const card = armCard('cascade-openai');
    expect(card).toHaveAttribute('data-arm-status', 'failed');
    expect(card).toHaveTextContent(
      'mt stage timed out for this utterance — session still running',
    );

    // Session survives: still connected, still stoppable.
    expect(connLabel()).toHaveTextContent('connected');
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeInTheDocument();
  });

  it('realtime failure is opaque — no stage attribution', async () => {
    const script: FixtureScriptEvent[] = [
      { at: 10, type: 'sourceText', kind: 'partial', text: SRC_PARTIAL_1, utt: 0 },
      { at: 300, type: 'error', message: 'response failed', opaque: true },
    ];
    renderApp({
      initialState: { mode: 'realtime', arms: ['realtime'] },
      scripts: { realtime: script },
    });
    await clickStartMicrophone();
    await advance(400);

    const card = armCard('realtime');
    expect(card).toHaveAttribute('data-arm-status', 'failed');
    expect(card).toHaveTextContent(COPY.realtimeFail);
    expect(connLabel()).toHaveTextContent('connected');
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeInTheDocument();
  });
});

describe('AC8 — live transcripts', () => {
  it('source shows accumulated partials then the final; target accumulates deltas', async () => {
    renderApp({
      initialState: CASCADE_SESSION,
      scripts: { 'cascade-openai': cascadeUtteranceScript() },
    });
    await clickStartMicrophone();

    await advance(20); // first partial
    expect(sourceCard()).toHaveTextContent(SRC_PARTIAL_1);

    await advance(30); // t=50: accumulated second partial
    expect(sourceCard()).toHaveTextContent(SRC_PARTIAL_2);

    await advance(550); // t=600: final transcript
    expect(sourceCard()).toHaveTextContent(SRC_FINAL);

    await advance(320); // t=920: first target delta
    expect(armCard('cascade-openai')).toHaveTextContent('Necesito programar');

    await advance(50); // t=970: accumulated deltas
    expect(armCard('cascade-openai')).toHaveTextContent('Necesito programar una cita');

    await advance(200); // t=1170: final translation
    expect(armCard('cascade-openai')).toHaveTextContent(TGT_FINAL);
  });
});

describe('AC9 — reconnect and disconnect banners', () => {
  const preamble: FixtureScriptEvent[] = [
    { at: 10, type: 'sourceText', kind: 'partial', text: SRC_PARTIAL_1, utt: 0 },
    { at: 50, type: 'sourceText', kind: 'final', text: SRC_FINAL, utt: 0 },
  ];

  it('reconnecting banner carries the attempt count; transcript history preserved', async () => {
    renderApp({
      initialState: CASCADE_SESSION,
      scripts: {
        'cascade-openai': [
          ...preamble,
          { at: 100, type: 'connection', state: 'reconnecting', attempt: 1 },
          { at: 200, type: 'connection', state: 'reconnecting', attempt: 2 },
        ],
      },
    });
    await clickStartMicrophone();
    await advance(250);

    expect(
      screen.getByText('Reconnecting — attempt 2 of 5 · transcript history preserved'),
    ).toBeInTheDocument();
    expect(connLabel()).toHaveTextContent('reconnecting…');
    expect(sourceCard()).toHaveTextContent(SRC_FINAL); // history preserved
  });

  it('after exhaustion: red disconnected banner + Reconnect button, transcript intact', async () => {
    renderApp({
      initialState: CASCADE_SESSION,
      scripts: {
        'cascade-openai': [
          ...preamble,
          { at: 100, type: 'connection', state: 'reconnecting', attempt: 1 },
          { at: 150, type: 'connection', state: 'disconnected' },
        ],
      },
    });
    await clickStartMicrophone();
    await advance(200);

    expect(screen.getByText(COPY.disconnectedBanner)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(connLabel()).toHaveTextContent('disconnected');
    expect(sourceCard()).toHaveTextContent(SRC_FINAL);
  });
});

describe('AC10 — stop → stopped summary with REAL numbers; ledger-backed footer', () => {
  function twoUtteranceRun(now: () => number) {
    return renderApp({
      now,
      initialState: CASCADE_SESSION,
      scripts: {
        'cascade-openai': [
          ...cascadeUtteranceScript({ utt: 0, base: 0 }),
          ...cascadeUtteranceScript({ utt: 1, base: 2000 }),
        ],
      },
    });
  }

  it('stopping shows the green summary from the machine summary and freezes elapsed', async () => {
    let t = 0;
    twoUtteranceRun(() => t);
    await clickStartMicrophone(); // startedAt = 0
    await advance(3400); // both utterances complete

    t = 302_000; // 5:02 elapsed
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await advance(100); // allow stop → flush → stopped

    // REAL numbers — never the mock's '5:02 · 32 utterances · $0.71' string.
    expect(
      screen.getByText('Session stopped · 5:02 · 2 utterances · 0 dropped · $0.01'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start new session' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop session' })).not.toBeInTheDocument();

    // Elapsed frozen at stoppedAt even as the clock keeps moving.
    expect(elapsedText()).toBe('05:02');
    t = 400_000;
    await advance(5000);
    expect(elapsedText()).toBe('05:02');
  });

  it('appends session-stamped records to the shared ledger', async () => {
    let t = 0;
    const { ledger } = twoUtteranceRun(() => t);
    await clickStartMicrophone();
    await advance(3400);

    const records = ledger.getRecords();
    expect(records).toHaveLength(2);
    // One shared live-session run id, stamped by the controller.
    expect(new Set(records.map((r) => r.runId)).size).toBe(1);
    expect(records[0]!.runId).toMatch(/^session/);
    expect(records.map((r) => r.arm)).toEqual(['cascade-openai', 'cascade-openai']);
  });

  it('footer figures come from the ledger aggregates; the illustrative pill never renders', async () => {
    let t = 0;
    twoUtteranceRun(() => t);
    await clickStartMicrophone();
    await advance(3400);

    const footer = sessionFooter();
    expect(footer).toHaveTextContent('2 utterances');
    expect(footer).toHaveTextContent('p50');
    expect(footer).toHaveTextContent('p95');
    // audio_queued − speech_end = 1053 ms for both records → 1.05 s.
    expect(footer).toHaveTextContent('1.05 s');
    // session cost = 2 × $0.005 = $0.01.
    expect(footer).toHaveTextContent('session');
    expect(footer).toHaveTextContent('$0.01');
    expect(screen.queryByText(/figures illustrative/i)).not.toBeInTheDocument();
  });

  function elapsedText(): string {
    const el = document.querySelector('[data-elapsed]');
    return el?.textContent?.trim() ?? '';
  }
});
