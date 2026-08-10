/**
 * Ticket 012 — Live view: one architecture per session.
 *
 * Idle default, four-value mic permission, the derived-arm pill, per-stage /
 * context-policy controls, the three switch triggers, Cantonese warnings, and
 * the absence of every multi-arm affordance. Flow-level behaviour (transports,
 * failures, reconnect, 5-minute cap, LiveSession) lives in
 * LiveView.flow.test.tsx.
 *
 * Everything renders through <App deps={fakes} /> (see sessionTestKit.ts).
 */

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { CascadeTransport, type WsLike } from '../transport/cascade';
import {
  RealtimeTransport,
  TOKEN_ENDPOINT,
  type RtcDataChannelLike,
  type RtcPeerConnectionLike,
  type RtcSessionDescriptionLike,
} from '../transport/realtime';
import type { SessionState } from '../state/sessionMachine';
import {
  DEFAULT_CASCADE_TRIPLE,
  MENUS,
  REALTIME_MODEL,
  armLabel,
  deriveArmTag,
} from '../../core/arms';
import {
  COPY,
  advance,
  armTagPill,
  cascadeUtteranceScript,
  clickStartMicrophone,
  connLabel,
  contextPolicyRow,
  deniedCard,
  elapsedLabel,
  flushMicrotasks,
  inputMeter,
  liveDot,
  makeDenyingCapture,
  makeDeps,
  makePendingCapture,
  micIndicator,
  realtimeUtteranceScript,
  renderApp,
  sourceCard,
  stageSelect,
  stateLabelEl,
  targetCards,
  text,
} from './sessionTestKit';

afterEach(cleanup);

// ---------------------------------------------------------------------------
// AC — idle default, purpose line, no mock-state simulator
// ---------------------------------------------------------------------------

describe('idle default on load', () => {
  it('renders the Live purpose line verbatim', () => {
    renderApp();
    expect(screen.getByText(COPY.purposeLine)).toBeInTheDocument();
  });

  it('renders the idle card: title, {pair} · {mode} subline, Start microphone', () => {
    renderApp();
    expect(screen.getByText(COPY.idleTitle)).toBeInTheDocument();
    expect(screen.getByText(COPY.idleSubline)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start microphone' })).toBeInTheDocument();
  });

  it('status strip: no connection, mic not requested, state idle, 5-bar meter', () => {
    renderApp();
    expect(connLabel()).toHaveTextContent('no connection');
    const mic = micIndicator();
    expect(mic).toHaveAttribute('data-mic-indicator', 'not-requested');
    expect(mic).toHaveTextContent(COPY.micNotRequested);
    expect(stateLabelEl()).toHaveTextContent('idle');
    expect(inputMeter().querySelectorAll('[data-meter-bar]')).toHaveLength(5);
  });

  it('elapsed reads M:SS / 5:00 · autoplay on', () => {
    renderApp();
    expect(text(elapsedLabel())).toBe('0:00 / 5:00 · autoplay on');
  });

  it('top bar has NO live dot while idle', () => {
    renderApp();
    expect(liveDot()).toBeNull();
  });

  it("never renders the mock's 'Mock state' review simulator", () => {
    renderApp();
    expect(screen.queryByText(/mock state/i)).not.toBeInTheDocument();
  });

  it('footer renders the utterance count but never the illustrative pill', () => {
    renderApp();
    expect(screen.getByText('0 utterances')).toBeInTheDocument();
    expect(screen.queryByText(/figures illustrative/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AC — exactly one architecture: every multi-arm affordance is gone
// ---------------------------------------------------------------------------

describe('one architecture — no comparison grid anywhere', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders exactly ONE target card and no arm grid, add pill or audible selector', async () => {
    renderApp({
      initialState: { mode: 'cascade' },
      scripts: { cascade: cascadeUtteranceScript() },
    });
    await clickStartMicrophone();
    await advance(1200);

    expect(targetCards()).toHaveLength(1);
    expect(document.querySelectorAll('[data-arm-card]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-arm-pill]')).toHaveLength(0);
    // No add-arm affordance and no "which arm do I hear" control.
    expect(screen.queryByRole('button', { name: /^\+ / })).not.toBeInTheDocument();
    expect(screen.queryByText(/two arms would talk over each other/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /audible/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /autoplay/i })).not.toBeInTheDocument();
    // One architecture → the source is not "shared by every arm".
    expect(sourceCard()).not.toHaveTextContent('shared by every arm');
  });
});

// ---------------------------------------------------------------------------
// AC (graded) — mic permission renders all four values and reflects the live one
// ---------------------------------------------------------------------------

describe('mic permission: live four-value indicator', () => {
  it('not-requested before anything is asked', () => {
    renderApp();
    const mic = micIndicator();
    expect(mic).toHaveAttribute('data-mic-indicator', 'not-requested');
    expect(mic).toHaveTextContent(COPY.micNotRequested);
  });

  it("requesting while the browser prompt is open — never optimistic", async () => {
    renderApp({ capture: makePendingCapture() });
    fireEvent.click(screen.getByRole('button', { name: 'Start microphone' }));
    await flushMicrotasks();
    const mic = micIndicator();
    expect(mic).toHaveAttribute('data-mic-indicator', 'requesting');
    expect(mic).toHaveTextContent(COPY.micRequesting);
    expect(liveDot()).toBeNull();
  });

  it('granted once capture resolves → live dot, listening, connected', async () => {
    renderApp();
    await clickStartMicrophone();
    const mic = micIndicator();
    expect(mic).toHaveAttribute('data-mic-indicator', 'granted');
    expect(mic).toHaveTextContent(COPY.micGranted);
    expect(liveDot()).not.toBeNull();
    expect(stateLabelEl()).toHaveTextContent('listening');
    expect(connLabel()).toHaveTextContent('connected');
  });

  it('denied → mic blocked + a BLOCKING card naming BOTH remediation layers', async () => {
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
    // Layer 1: the browser's per-site permission.
    expect(card).toHaveTextContent(/site permission/i);
    expect(card).toHaveTextContent(/address bar/i);
    // Layer 2: the operating system's microphone privacy setting.
    expect(card).toHaveTextContent(/OS microphone setting|system.*privacy/i);
    // Why a bare retry appears to do nothing.
    expect(card).toHaveTextContent(COPY.noRePrompt);
    expect(card!.querySelector('button[aria-label*="close" i]')).toBeNull();
  });

  it('START is blocked while denied — retry never re-invokes the capture seam', async () => {
    const capture = makeDenyingCapture();
    renderApp({ capture });
    await clickStartMicrophone();
    expect(capture).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry microphone' }));
    await flushMicrotasks();

    // Browsers do not re-prompt after a denial, so the seam must not be hit.
    expect(capture).toHaveBeenCalledTimes(1);
    expect(deniedCard()).not.toBeNull();
    expect(micIndicator()).toHaveAttribute('data-mic-indicator', 'denied');
    expect(screen.queryByRole('button', { name: 'Stop session' })).not.toBeInTheDocument();
  });

  it('denied blocks Live only — Results stays usable', async () => {
    renderApp({ capture: makeDenyingCapture() });
    await clickStartMicrophone();
    fireEvent.click(screen.getByRole('button', { name: 'Results' }));
    expect(screen.getByText('No runs recorded')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AC — the derived-arm pill (deriveArmTag; never set by a control)
// ---------------------------------------------------------------------------

describe('derived-arm pill', () => {
  function pillState() {
    const el = armTagPill();
    return { tag: el.getAttribute('data-arm-tag'), label: text(el) };
  }

  it('realtime on the pinned snapshot is Arm A — Live passes the model explicitly', async () => {
    const { configs } = renderApp();
    expect(pillState()).toEqual({ tag: 'A', label: 'this is Arm A' });

    // The transport/token DEFAULT is the cheap development model, which
    // correctly derives to 'ad-hoc'; Live must resolve the pinned snapshot
    // BEFORE the config reaches the factory and deriveArmTag.
    await clickStartMicrophone();
    const realtimeConfigs = configs.filter((c) => c.architecture === 'realtime');
    expect(realtimeConfigs.length).toBeGreaterThan(0);
    for (const config of realtimeConfigs) {
      expect(config.realtimeModel).toBe(REALTIME_MODEL);
      expect(config.realtimeModel).not.toBe('gpt-realtime-mini');
      expect(deriveArmTag(config)).toBe('A');
    }
  });

  it("cascade hands the factory the configured triple", async () => {
    const { configs } = renderApp({ initialState: { mode: 'cascade' } });
    await clickStartMicrophone();
    const cascadeConfigs = configs.filter((c) => c.architecture === 'cascade');
    expect(cascadeConfigs.length).toBeGreaterThan(0);
    for (const config of cascadeConfigs) {
      expect(config.providers).toEqual(DEFAULT_CASCADE_TRIPLE);
      expect(deriveArmTag(config)).toBe('B');
    }
  });

  it("cascade on Arm B's frozen triple reads 'this is Arm B'", () => {
    renderApp({ initialState: { mode: 'cascade' } });
    expect(pillState()).toEqual({ tag: 'B', label: 'this is Arm B' });
    expect(armLabel(deriveArmTag({ architecture: 'cascade', providers: DEFAULT_CASCADE_TRIPLE })))
      .toBe('Arm B');
  });

  it("swapping the TTS stage to Arm C's model reads 'this is Arm C'", () => {
    renderApp({ initialState: { mode: 'cascade' } });
    // gpt-4o-mini-tts -> eleven_flash_v2_5 (MENUS.tts order).
    fireEvent.click(stageSelect('tts')!);
    expect(stageSelect('tts')).toHaveTextContent(MENUS.tts[1]!);
    expect(pillState()).toEqual({ tag: 'C', label: 'this is Arm C' });
  });

  it("an off-arm triple reads 'ad-hoc' with no arm name", () => {
    renderApp({ initialState: { mode: 'cascade' } });
    // gpt-4o-transcribe -> gpt-4o-mini-transcribe: matches no frozen recipe.
    fireEvent.click(stageSelect('stt')!);
    expect(stageSelect('stt')).toHaveTextContent(MENUS.stt[1]!);
    expect(pillState()).toEqual({ tag: 'ad-hoc', label: 'ad-hoc' });
  });

  it('no control anywhere sets an arm tag directly', () => {
    renderApp({ initialState: { mode: 'cascade' } });
    // The pill is a derived readout, not a picker.
    expect(armTagPill().tagName).not.toBe('BUTTON');
    expect(armTagPill().querySelector('button, select, input')).toBeNull();
    for (const name of [/arm a/i, /arm b/i, /arm c/i, /ad-hoc/i]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });
});

// ---------------------------------------------------------------------------
// AC — per-stage selectors (cascade) and context policy (realtime, Live-only)
// ---------------------------------------------------------------------------

describe('second control row follows the architecture', () => {
  it('cascade shows three per-stage selectors seeded with the default triple', () => {
    renderApp({ initialState: { mode: 'cascade' } });
    expect(stageSelect('stt')).toHaveTextContent(DEFAULT_CASCADE_TRIPLE.stt);
    expect(stageSelect('mt')).toHaveTextContent(DEFAULT_CASCADE_TRIPLE.mt);
    expect(stageSelect('tts')).toHaveTextContent(DEFAULT_CASCADE_TRIPLE.tts);
    // Context policy is Realtime-only.
    expect(contextPolicyRow()).toBeNull();
  });

  it('a stage selector cycles through that stage menu', () => {
    renderApp({ initialState: { mode: 'cascade' } });
    for (const model of [...MENUS.mt.slice(1), MENUS.mt[0]!]) {
      fireEvent.click(stageSelect('mt')!);
      expect(stageSelect('mt')).toHaveTextContent(model);
    }
  });

  it('realtime shows the context-policy toggle with its cost note; no stage selectors', () => {
    renderApp();
    expect(stageSelect('stt')).toBeNull();
    expect(stageSelect('mt')).toBeNull();
    expect(stageSelect('tts')).toBeNull();

    expect(contextPolicyRow()).toHaveAttribute('data-context-policy', 'default');
    expect(screen.getByRole('button', { name: 'default' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'trimmed' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText(COPY.ctxNoteDefault)).toBeInTheDocument();
  });

  it('picking trimmed swaps the selection and the cost note', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'trimmed' }));
    expect(contextPolicyRow()).toHaveAttribute('data-context-policy', 'trimmed');
    expect(screen.getByRole('button', { name: 'trimmed' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText(COPY.ctxNoteTrimmed)).toBeInTheDocument();
    expect(screen.queryByText(COPY.ctxNoteDefault)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AC — ONE queue mechanism, THREE triggers: mode, pair, direction
// ---------------------------------------------------------------------------

describe('switch queueing at the utterance boundary', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Start a realtime session and stop 50 ms in — an utterance is in flight. */
  async function midUtterance() {
    const kit = renderApp({
      scripts: { realtime: realtimeUtteranceScript(), cascade: cascadeUtteranceScript() },
    });
    await clickStartMicrophone();
    await advance(50);
    expect(stateLabelEl()).toHaveTextContent('processing');
    return kit;
  }

  const triggers: Array<{
    name: string;
    click: () => void;
    banner: string;
    /** Reads the setting that must NOT change before the boundary. */
    settled: () => void;
    unsettled: () => void;
  }> = [
    {
      name: 'mode',
      click: () => fireEvent.click(screen.getByRole('button', { name: 'Cascade' })),
      banner: 'switching to Cascade after this sentence finishes',
      unsettled: () =>
        expect(screen.getByRole('button', { name: 'Cascade' })).toHaveAttribute(
          'aria-pressed',
          'false',
        ),
      settled: () =>
        expect(screen.getByRole('button', { name: 'Cascade' })).toHaveAttribute(
          'aria-pressed',
          'true',
        ),
    },
    {
      name: 'language pair',
      click: () => fireEvent.click(screen.getByRole('button', { name: /English → Spanish/ })),
      banner: 'switching to English → Cantonese after this sentence finishes',
      unsettled: () =>
        expect(screen.getByRole('button', { name: /English → Spanish/ })).toBeInTheDocument(),
      settled: () =>
        expect(screen.getByRole('button', { name: /English → Cantonese/ })).toBeInTheDocument(),
    },
    {
      name: 'direction',
      click: () => fireEvent.click(screen.getByRole('button', { name: 'Swap direction' })),
      banner: 'switching to Spanish → English after this sentence finishes',
      unsettled: () =>
        expect(screen.getByRole('button', { name: /English → Spanish/ })).toBeInTheDocument(),
      settled: () =>
        expect(screen.getByRole('button', { name: /Spanish → English/ })).toBeInTheDocument(),
    },
  ];

  for (const t of triggers) {
    it(`${t.name} requested MID-UTTERANCE queues, then applies at the boundary`, async () => {
      await midUtterance();

      t.click();
      expect(screen.getByText(t.banner)).toBeInTheDocument();
      // The PRD's visible 'switch-queued' state, derived from the overlay.
      expect(stateLabelEl()).toHaveTextContent('switch-queued');
      t.unsettled();

      await advance(1200); // the utterance settles → boundary
      expect(screen.queryByText(t.banner)).not.toBeInTheDocument();
      expect(stateLabelEl()).not.toHaveTextContent('switch-queued');
      t.settled();
    });

    it(`${t.name} requested AT a boundary applies immediately, no banner`, async () => {
      renderApp({
        scripts: { realtime: realtimeUtteranceScript(), cascade: cascadeUtteranceScript() },
      });
      await clickStartMicrophone();
      await advance(1100); // utterance 0 settled → ready, nothing in flight
      expect(stateLabelEl()).toHaveTextContent('ready');

      t.click();
      expect(screen.queryByText(/^switching to/)).not.toBeInTheDocument();
      t.settled();
    });
  }

  it('idle is a boundary too: a mode switch applies instantly', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Cascade' }));
    expect(screen.queryByText(/^switching to/)).not.toBeInTheDocument();
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

// ---------------------------------------------------------------------------
// AC — language pair, direction, and the Cantonese warning (warn, never block)
// ---------------------------------------------------------------------------

describe('language pair, direction and the Cantonese-on-Realtime warning', () => {
  it('EN↔ES default shows the both-modes pill and no Cantonese warning', () => {
    renderApp();
    expect(screen.getByRole('button', { name: /English → Spanish/ })).toBeInTheDocument();
    expect(screen.getByText('both modes')).toBeInTheDocument();
    expect(screen.queryByText(COPY.cantoInputWarn)).not.toBeInTheDocument();
  });

  // TICKET 074 — the forward warning is retired. The operator has run EN→YUE
  // on Realtime and heard Cantonese; the banner claimed a working
  // configuration was unsupported, and the pill claimed the pair was cascade
  // only (a constraint belonging to a model this project does not run — 073).
  it('target Cantonese on Realtime warns about NOTHING and shows the both-modes pill', async () => {
    renderApp({ initialState: { mode: 'realtime', langIdx: 1 } });
    expect(screen.getByText('both modes')).toBeInTheDocument();
    expect(screen.queryByText('cascade only')).not.toBeInTheDocument();
    expect(screen.queryByText(COPY.cantoTargetWarn)).not.toBeInTheDocument();

    // Still never blocks: Start is live and the session runs.
    const start = screen.getByRole('button', { name: 'Start microphone' });
    expect(start).toBeEnabled();
    await clickStartMicrophone();
    expect(stateLabelEl()).toHaveTextContent('listening');
    expect(screen.queryByText(COPY.cantoTargetWarn)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeInTheDocument();
  });

  // ...and the REVERSE direction keeps its warning, untouched. Cantonese
  // speech INPUT on Realtime was never tested and is not cleared by the
  // forward observation.
  it('swapping to Cantonese INPUT on Realtime still fires the input warning', () => {
    renderApp({ initialState: { mode: 'realtime', langIdx: 1 } });
    fireEvent.click(screen.getByRole('button', { name: 'Swap direction' }));
    expect(screen.getByRole('button', { name: /Cantonese → English/ })).toBeInTheDocument();
    expect(screen.getByText(COPY.cantoInputWarn)).toBeInTheDocument();
    expect(screen.queryByText(COPY.cantoTargetWarn)).not.toBeInTheDocument();
  });

  it('the same pair on Cascade warns about nothing', () => {
    renderApp({ initialState: { mode: 'cascade', langIdx: 1 } });
    expect(screen.getByText('both modes')).toBeInTheDocument();
    expect(screen.queryByText(COPY.cantoTargetWarn)).not.toBeInTheDocument();
    expect(screen.queryByText(COPY.cantoInputWarn)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// TICKET 062 — the Live selector must reach the SESSION, not only the label.
//
// Every assertion in the suite above reads a button's accessible name. That is
// precisely the blind spot: run dbeb6d94 translated English into GERMAN on an
// English↔Spanish project while a spec audit and a manual QA pass both marked
// rubric must-have #5 ✅, because the selector renders and switches correctly.
//
// So these tests drive the REAL RealtimeTransport and the REAL CascadeTransport
// over faked browser primitives (jsdom has neither RTCPeerConnection nor
// WebSocket-with-binaryType) and assert the bytes that leave them.
// ---------------------------------------------------------------------------

describe('TICKET 062 — a language switch reaches the wire, not just the label', () => {
  /** A peer connection with no media surface at all — the transport's floor. */
  class WirePc implements RtcPeerConnectionLike {
    channels: WireChannel[] = [];
    closed = false;
    createDataChannel(label: string): WireChannel {
      const ch = new WireChannel(label);
      this.channels.push(ch);
      return ch;
    }
    async createOffer(): Promise<RtcSessionDescriptionLike> {
      return { type: 'offer', sdp: 'v=0 live-offer' };
    }
    async setLocalDescription(): Promise<void> {}
    async setRemoteDescription(): Promise<void> {}
    close(): void {
      this.closed = true;
    }
  }

  class WireChannel implements RtcDataChannelLike {
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly label: string) {}
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {}
  }

  class WireWs implements WsLike {
    binaryType = '';
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    send(data: string | ArrayBufferLike | Uint8Array): void {
      if (typeof data === 'string') this.sent.push(data);
    }
    close(): void {}
  }

  const fetchImpl = (async (url: RequestInfo | URL) => {
    if (String(url).includes(TOKEN_ENDPOINT)) {
      return { ok: true, status: 200, json: async () => ({ value: 'tok' }) } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => 'v=0 live-answer' } as unknown as Response;
  }) as typeof fetch;

  /** Flush the transport handshake's promise chain (token → offer → answer). */
  async function settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 25; i += 1) await Promise.resolve();
    });
  }

  interface Wire {
    /** Every session.update instruction string put on a realtime data channel. */
    realtimeInstructions: () => string[];
    /** Every session.start frame put on a cascade socket, parsed. */
    cascadeStarts: () => { languagePair?: string; direction?: string; targetLanguage?: string }[];
    open: () => void;
  }

  /** Renders <App/> whose Live transports are the REAL ones over faked wires. */
  async function mountWired(initialState?: Partial<SessionState>): Promise<Wire> {
    cleanup();
    const kit = makeDeps({ initialState });
    const pcs: WirePc[] = [];
    const sockets: WireWs[] = [];
    kit.deps.transportFactory = (config) => {
      if (config.architecture === 'realtime') {
        return new RealtimeTransport(
          { armId: 'live', model: config.realtimeModel },
          {
            fetchImpl,
            rtcFactory: () => {
              const pc = new WirePc();
              pcs.push(pc);
              return pc;
            },
            now: () => 0,
          },
        );
      }
      return new CascadeTransport(
        { armId: 'live', baseUrl: 'ws://live.test' },
        {
          wsFactory: () => {
            const ws = new WireWs();
            sockets.push(ws);
            return ws;
          },
          now: () => 0,
        },
      );
    };
    render(createElement(App, { deps: kit.deps }));
    await clickStartMicrophone();
    const open = (): void => {
      for (const pc of pcs) for (const ch of pc.channels) ch.onopen?.();
      for (const ws of sockets) ws.onopen?.();
    };
    await settle();
    open();
    return {
      open,
      realtimeInstructions: () =>
        pcs
          .flatMap((pc) => pc.channels)
          .flatMap((ch) => ch.sent)
          .map((raw) => JSON.parse(raw) as { type?: string; session?: { instructions?: string } })
          .filter((m) => m.type === 'session.update')
          .map((m) => String(m.session?.instructions ?? '')),
      cascadeStarts: () =>
        sockets
          .flatMap((ws) => ws.sent)
          .map((raw) => JSON.parse(raw) as { type?: string } & Record<string, unknown>)
          .filter((m) => m.type === 'session.start') as ReturnType<Wire['cascadeStarts']>,
    };
  }

  it('REALTIME: the session opens on the DEFAULT pair instructing Spanish', async () => {
    const wire = await mountWired();
    expect(wire.realtimeInstructions()).toHaveLength(1);
    expect(wire.realtimeInstructions()[0]).toContain('Spanish');
    expect(wire.realtimeInstructions()[0]).not.toContain('English');
  });

  it('REALTIME: switching the pair to EN↔YUE re-instructs the session in Cantonese', async () => {
    const wire = await mountWired();
    expect(wire.realtimeInstructions().at(-1)).toContain('Spanish');

    // A boundary (nothing in flight) — the pair applies immediately, and the
    // button label already proves it did. The label is not the session.
    fireEvent.click(screen.getByRole('button', { name: /English → Spanish/ }));
    expect(screen.getByRole('button', { name: /English → Cantonese/ })).toBeInTheDocument();
    await settle();
    wire.open();
    await settle();

    const instructions = wire.realtimeInstructions();
    expect(instructions.length).toBeGreaterThanOrEqual(2);
    expect(instructions.at(-1)).toContain('Cantonese');
    expect(instructions.at(-1)).not.toContain('Spanish');
  });

  it('REALTIME: swapping the direction re-instructs the session in English', async () => {
    const wire = await mountWired();
    expect(wire.realtimeInstructions().at(-1)).toContain('Spanish');

    fireEvent.click(screen.getByRole('button', { name: 'Swap direction' }));
    expect(screen.getByRole('button', { name: /Spanish → English/ })).toBeInTheDocument();
    await settle();
    wire.open();
    await settle();

    const instructions = wire.realtimeInstructions();
    expect(instructions.length).toBeGreaterThanOrEqual(2);
    // EN→ES and ES→EN MUST produce different payloads (AC5). A label-only swap
    // leaves the model translating into Spanish while the UI claims English.
    expect(instructions.at(-1)).toContain('English');
    expect(instructions.at(-1)).not.toContain('Spanish');
  });

  it('CASCADE: switching the pair re-opens session.start with the NEW pair and direction', async () => {
    const wire = await mountWired({ mode: 'cascade' });
    expect(wire.cascadeStarts().at(-1)).toMatchObject({
      languagePair: 'EN↔ES',
      direction: 'en→es',
    });

    fireEvent.click(screen.getByRole('button', { name: /English → Spanish/ }));
    await settle();
    wire.open();
    await settle();

    expect(wire.cascadeStarts().at(-1)).toMatchObject({
      languagePair: 'EN↔YUE',
      direction: 'en→yue',
    });
  });

  it('CASCADE: swapping the direction re-opens session.start reversed', async () => {
    const wire = await mountWired({ mode: 'cascade' });
    fireEvent.click(screen.getByRole('button', { name: 'Swap direction' }));
    await settle();
    wire.open();
    await settle();

    expect(wire.cascadeStarts().at(-1)).toMatchObject({
      languagePair: 'EN↔ES',
      direction: 'es→en',
    });
  });
});
