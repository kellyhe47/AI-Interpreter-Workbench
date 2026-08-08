/**
 * Ticket 046 — WHERE the inbound tap is wired, and where it must NOT be.
 *
 * `browserDeps.ts` is deliberately untested elsewhere: it is the one module made
 * entirely of real browser objects. But this ticket's failure mode is a WIRING
 * one in both directions —
 *
 *   - a tap absent from `buildReplayDeps` means Arm A still captures nothing and
 *     every unit below it passes while the product is unchanged (a seam nothing
 *     wires is a seam that does not exist);
 *   - a tap present in `buildBrowserDeps` means LIVE starts storing audio, which
 *     it must never do (§17 19h). Live plays the model's track through the
 *     ticket-040 `remoteAudioSink` and persists nothing at all.
 *
 * So the wiring itself is asserted: the Live bag is inspected as an object, and
 * the Replay branch — which `ReplayDeps` deliberately does not expose — is
 * asserted against the module source.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBrowserDeps } from './browserDeps';
import type { RealtimeDeps } from './transport/realtime';
import type { LiveRunConfig } from './views/useSessionController';

const SOURCE = readFileSync(resolve(process.cwd(), 'src/client/browserDeps.ts'), 'utf8');

/** The realtime transport's injected deps bag, read off the instance. */
function realtimeDepsOf(transport: unknown): RealtimeDeps {
  return (transport as { deps: RealtimeDeps }).deps;
}

const LIVE_REALTIME: LiveRunConfig = {
  architecture: 'realtime',
  realtimeModel: 'gpt-realtime-mini',
  contextPolicy: 'default',
};

describe('browserDeps — the inbound tap is REPLAY ONLY (ticket 046)', () => {
  it('the REPLAY realtime branch wires createInboundAudioTap', () => {
    const replayHalf = SOURCE.split('export function buildBrowserDeps')[0]!;
    expect(replayHalf.includes('createInboundAudioTap')).toBe(true);
    // Built from the production module, not hand-rolled at the wiring site.
    expect(SOURCE.includes("from './audio/inboundAudio'")).toBe(true);
  });

  it('REGRESSION GUARD: the LIVE transport factory wires NO tap — Live persists no audio at all', () => {
    const liveHalf = SOURCE.split('export function buildBrowserDeps')[1]!;
    expect(liveHalf.includes('createInboundAudioTap')).toBe(false);

    // ...and the built bag agrees: playback yes, capture no, outbound no.
    const deps = buildBrowserDeps();
    const bag = realtimeDepsOf(deps.transportFactory(LIVE_REALTIME));
    expect(bag.remoteAudioSink).toBeDefined();
    expect(bag.createInboundAudioTap).toBeUndefined();
    expect(bag.createOutboundAudioSink).toBeUndefined();
    expect(bag.getMediaStream).toBeDefined();
  });
});
