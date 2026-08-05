/**
 * Ticket 012 — Session view: idle default, mic permission, mode switching,
 * language/direction warnings, arms strip (ACs 1–5).
 *
 * Everything renders through <App deps={fakes} /> (see sessionTestKit.ts) so
 * the TopBar composition is exercised too. Flow-level ACs 6–10 live in
 * SessionView.flow.test.tsx.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COPY,
  advance,
  armCardIds,
  armPillIds,
  autoplayLabel,
  clickStartMicrophone,
  connLabel,
  deniedCard,
  flushMicrotasks,
  liveDot,
  makeDenyingCapture,
  makePendingCapture,
  micIndicator,
  cascadeUtteranceScript,
  realtimeUtteranceScript,
  renderApp,
  sourceCard,
  stateLabel,
} from './sessionTestKit';

afterEach(cleanup);

describe('AC1 — idle default on load', () => {
  it('renders the idle card: title, {pair} · {mode} subline, Start microphone', () => {
    renderApp();
    expect(screen.getByText(COPY.idleTitle)).toBeInTheDocument();
    expect(screen.getByText(COPY.idleSubline)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start microphone' })).toBeInTheDocument();
  });

  it('status strip: no connection, mic not requested, state idle, 00:00', () => {
    renderApp();
    expect(connLabel()).toHaveTextContent('no connection');
    const mic = micIndicator();
    expect(mic).toHaveAttribute('data-mic-indicator', 'not-requested');
    expect(mic).toHaveTextContent(COPY.micNotRequested);
    expect(stateLabel()).toHaveTextContent('idle');
    expect(elapsedText()).toBe('00:00');
  });

  it('top bar has NO live dot while idle', () => {
    renderApp();
    expect(liveDot()).toBeNull();
  });

  it("never renders the mock's 'Mock state' chips row", () => {
    renderApp();
    expect(screen.queryByText(/mock state/i)).not.toBeInTheDocument();
  });

  it('footer renders the utterance count but never the illustrative pill', () => {
    renderApp();
    expect(screen.getByText('0 utterances')).toBeInTheDocument();
    expect(screen.queryByText(/figures illustrative/i)).not.toBeInTheDocument();
  });

  function elapsedText(): string {
    const el = document.querySelector('[data-elapsed]');
    return el?.textContent?.trim() ?? '';
  }
});

describe('AC2 — mic permission: live four-value indicator', () => {
  it('granting capture → mic allowed (granted), live dot, listening, connected', async () => {
    renderApp();
    await clickStartMicrophone();
    const mic = micIndicator();
    expect(mic).toHaveAttribute('data-mic-indicator', 'granted');
    expect(mic).toHaveTextContent(COPY.micGranted);
    expect(liveDot()).not.toBeNull();
    expect(stateLabel()).toHaveTextContent('listening');
    expect(connLabel()).toHaveTextContent('connected');
  });

  it("while the browser prompt is open → 'mic prompt open…' (requesting)", async () => {
    renderApp({ capture: makePendingCapture() });
    fireEvent.click(screen.getByRole('button', { name: 'Start microphone' }));
    await flushMicrotasks();
    const mic = micIndicator();
    expect(mic).toHaveAttribute('data-mic-indicator', 'requesting');
    expect(mic).toHaveTextContent(COPY.micRequesting);
    expect(liveDot()).toBeNull();
  });

  it('denied → mic blocked + blocking card covering the browser AND OS layers', async () => {
    renderApp({ capture: makeDenyingCapture() });
    await clickStartMicrophone();

    const mic = micIndicator();
    expect(mic).toHaveAttribute('data-mic-indicator', 'denied');
    expect(mic).toHaveTextContent(COPY.micDenied);

    // The remediation card REPLACES the idle card and is not dismissible.
    expect(screen.queryByText(COPY.idleTitle)).not.toBeInTheDocument();
    const card = deniedCard();
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent(COPY.deniedHeading);
    expect(card).toHaveTextContent(/browser site permission/i);
    expect(card).toHaveTextContent(/OS microphone setting/i);
    expect(card).toHaveTextContent(COPY.noRePrompt);
    expect(card).toHaveTextContent(/reset the site permission/i);
    expect(card!.querySelector('button[aria-label*="close" i]')).toBeNull();
  });

  it('START is a no-op while denied — retry never re-invokes capture', async () => {
    const capture = makeDenyingCapture();
    renderApp({ capture });
    await clickStartMicrophone();
    expect(capture).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry microphone' }));
    await flushMicrotasks();

    expect(capture).toHaveBeenCalledTimes(1);
    expect(deniedCard()).not.toBeNull();
    expect(micIndicator()).toHaveAttribute('data-mic-indicator', 'denied');
  });
});

describe('AC3 — mode switch queues ONLY while an utterance is in flight (ticket 019)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('in-flight request: banner while streaming; settle clears it AND the new mode + arm apply', async () => {
    renderApp({
      initialState: { mode: 'realtime', arms: ['realtime'] },
      scripts: { realtime: realtimeUtteranceScript() },
    });
    await clickStartMicrophone();
    await advance(50); // first source partial arrived → utterance in flight

    fireEvent.click(screen.getByRole('button', { name: 'Cascade' }));
    expect(
      screen.getByText('switching to Cascade after this sentence finishes'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cascade' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await advance(1200); // fixture utterance settles → boundary
    expect(
      screen.queryByText('switching to Cascade after this sentence finishes'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cascade' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The regression that matters (QA iteration 2): the switch actually
    // LANDS — the single arm swaps to the new mode's catalog arm.
    expect(armPillIds()).toEqual(['cascade-openai']);
    expect(armCardIds()).toEqual(['cascade-openai']);
  });

  it('request while ready (no utterance in flight) applies immediately — no banner', async () => {
    renderApp({
      initialState: { mode: 'cascade', arms: ['cascade-openai'] },
      scripts: { 'cascade-openai': cascadeUtteranceScript() },
    });
    await clickStartMicrophone();
    await advance(1300); // utterance 0 settled → ready, nothing in flight
    expect(stateLabel()).toHaveTextContent('ready');

    fireEvent.click(screen.getByRole('button', { name: 'Realtime' }));
    expect(screen.queryByText(/switching to/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Realtime' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(armPillIds()).toEqual(['realtime']);
  });

  it('idle: mode applies instantly with no banner', () => {
    // Ticket 017: default is Realtime, so the instant idle switch is → Cascade.
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Cascade' }));
    expect(screen.queryByText(/switching to/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cascade' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Realtime' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('AC4 — language cycle, direction swap, Cantonese warnings', () => {
  it('EN↔ES default shows the both-modes pill and no Cantonese warning', () => {
    renderApp();
    expect(screen.getByRole('button', { name: /English → Spanish/ })).toBeInTheDocument();
    expect(screen.getByText('both modes')).toBeInTheDocument();
    expect(screen.queryByText(COPY.cantoTargetWarn)).not.toBeInTheDocument();
    expect(screen.queryByText(COPY.cantoInputWarn)).not.toBeInTheDocument();
  });

  it('cycling to EN↔YUE on realtime (the 017 default) → cascade-only pill + exact target warning', () => {
    renderApp(); // Ticket 017: Realtime is the default — no mode click needed
    fireEvent.click(screen.getByRole('button', { name: /English → Spanish/ }));

    expect(screen.getByRole('button', { name: /English → Cantonese/ })).toBeInTheDocument();
    expect(screen.getByText('cascade only')).toBeInTheDocument();
    expect(screen.getByText(COPY.cantoTargetWarn)).toBeInTheDocument();
    expect(screen.queryByText(COPY.cantoInputWarn)).not.toBeInTheDocument();
  });

  it('reversed YUE→EN flips to the input warning; selection is never blocked', () => {
    renderApp(); // Ticket 017: Realtime default
    fireEvent.click(screen.getByRole('button', { name: /English → Spanish/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Swap direction' }));

    // Selection went through (warn, never block):
    expect(screen.getByRole('button', { name: /Cantonese → English/ })).toBeInTheDocument();
    expect(screen.getByText(COPY.cantoInputWarn)).toBeInTheDocument();
    expect(screen.queryByText(COPY.cantoTargetWarn)).not.toBeInTheDocument();
    expect(screen.getByText('cascade only')).toBeInTheDocument();
  });

  it('cascade-only pair on cascade mode warns about nothing', () => {
    renderApp();
    // Ticket 017: default is Realtime — switch to cascade first (idle: instant).
    fireEvent.click(screen.getByRole('button', { name: 'Cascade' }));
    fireEvent.click(screen.getByRole('button', { name: /English → Spanish/ }));
    expect(screen.getByText('cascade only')).toBeInTheDocument();
    expect(screen.queryByText(COPY.cantoTargetWarn)).not.toBeInTheDocument();
    expect(screen.queryByText(COPY.cantoInputWarn)).not.toBeInTheDocument();
  });
});

describe('AC5 — arms strip', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function startRealtimeSession() {
    const kit = renderApp({ initialState: { mode: 'realtime', arms: ['realtime'] } });
    await clickStartMicrophone();
    return kit;
  }

  const ADD_CASCADE = '+ Cascade · OpenAI · $0.021/min';
  const ADD_BEST = '+ Cascade · best-of-breed · $0.055/min';

  it('single arm: Realtime pill + dashed add pill priced before enabling', async () => {
    await startRealtimeSession();
    expect(armPillIds()).toEqual(['realtime']);
    expect(screen.getByRole('button', { name: ADD_CASCADE })).toBeInTheDocument();
    const autoplay = screen.getByRole('checkbox', { name: 'autoplay' });
    expect(autoplay).toBeChecked();
    expect(autoplayLabel()).toHaveTextContent('autoplay on');
  });

  it('adding an arm → two arm cards, autoplay forced off + note, shared source suffix', async () => {
    await startRealtimeSession();
    fireEvent.click(screen.getByRole('button', { name: ADD_CASCADE }));
    await flushMicrotasks();

    expect(armCardIds()).toEqual(['realtime', 'cascade-openai']);
    expect(armPillIds()).toEqual(['realtime', 'cascade-openai']);
    expect(screen.queryByRole('checkbox', { name: 'autoplay' })).not.toBeInTheDocument();
    expect(autoplayLabel()).toHaveTextContent('autoplay off');
    expect(screen.getByText(COPY.multiArmNote)).toBeInTheDocument();
    expect(sourceCard()).toHaveTextContent('Source · English — shared by every arm');
  });

  it('removing back to one arm restores autoplay and drops the suffix', async () => {
    await startRealtimeSession();
    fireEvent.click(screen.getByRole('button', { name: ADD_CASCADE }));
    await flushMicrotasks();
    fireEvent.click(screen.getByRole('button', { name: 'remove Cascade · OpenAI' }));
    await flushMicrotasks();

    expect(armCardIds()).toEqual(['realtime']);
    expect(screen.getByRole('checkbox', { name: 'autoplay' })).toBeChecked();
    expect(autoplayLabel()).toHaveTextContent('autoplay on');
    expect(sourceCard()).not.toHaveTextContent('shared by every arm');
    expect(screen.queryByText(COPY.multiArmNote)).not.toBeInTheDocument();
  });

  it('at the 3-arm maximum there is no add pill', async () => {
    await startRealtimeSession();
    fireEvent.click(screen.getByRole('button', { name: ADD_CASCADE }));
    await flushMicrotasks();
    fireEvent.click(screen.getByRole('button', { name: ADD_BEST }));
    await flushMicrotasks();

    expect(armCardIds()).toEqual(['realtime', 'cascade-openai', 'cascade-best']);
    expect(screen.queryByRole('button', { name: /^\+ / })).not.toBeInTheDocument();
  });
});

describe('Ticket 016 — elapsed timer must not run without a running session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function elapsedText(): string {
    const el = document.querySelector('[data-elapsed]');
    return el?.textContent?.trim() ?? '';
  }

  it('permission-denied shows 00:00 and does not advance while the wall clock ticks', async () => {
    let t = 0;
    renderApp({ capture: makeDenyingCapture(), now: () => t });

    fireEvent.click(screen.getByRole('button', { name: 'Start microphone' }));
    t = 31_000; // clock moves while the prompt is open / denial resolves
    await flushMicrotasks();

    expect(micIndicator()).toHaveAttribute('data-mic-indicator', 'denied');
    expect(elapsedText()).toBe('00:00');

    t = 53_000;
    await advance(5_000); // any ticking interval would re-render here
    expect(elapsedText()).toBe('00:00');
  });
});

describe('Ticket 017 — default mode is Realtime', () => {
  it('cold open pre-selects Realtime and the idle subline says Realtime', () => {
    renderApp();
    expect(screen.getByRole('button', { name: 'Realtime' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Cascade' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText(COPY.idleSubline)).toBeInTheDocument();
  });

  it('a default session starts with the realtime catalog arm', async () => {
    renderApp();
    await clickStartMicrophone();
    expect(armPillIds()).toEqual(['realtime']);
  });
});
