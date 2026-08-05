/**
 * Ticket 011 — ArmRouter: fans mic audio out to every active arm and funnels
 * per-arm transport events back with the armId attached.
 *
 * ============================ API DESIGN (normative) =======================
 * Locked by router.test.ts:
 *
 * new ArmRouter()
 * - addArm(transport): registers the transport under transport.armId and
 *   wires transport.setHandlers with wrappers that inject the armId into
 *   every callback (see ArmRouterHandlers — every event object carries
 *   `armId`). Adding a duplicate armId throws. addArm does NOT start the
 *   transport — lifecycle stays with the caller.
 * - removeArm(armId): calls stop() on THAT transport only and removes it;
 *   other arms keep receiving sendAudio and keep delivering events. Unknown
 *   armId is a no-op.
 * - sendAudio(chunk): fans the SAME chunk reference out to every active
 *   arm's transport.sendAudio, in insertion order.
 * - setHandlers(handlers): router-level handlers; may be called before or
 *   after arms are added, and replaces the previous set for ALL arms (the
 *   per-arm wrappers always delegate to the current router handlers).
 * - armIds: string[] getter, insertion order.
 * - getArm(armId): the registered transport or undefined.
 * - stopAll(): stops and removes every arm.
 * ==========================================================================
 */

import type {
  ConnectionState,
  InterpreterTransport,
  SourceTextEvent,
  TargetTextEvent,
  TimingMark,
  TransportError,
  UtteranceCompletion,
} from './types';

export interface ArmRouterHandlers {
  onSourceText?: (e: SourceTextEvent & { armId: string }) => void;
  onTargetText?: (e: TargetTextEvent & { armId: string }) => void;
  onAudio?: (e: { armId: string; pcm: Int16Array; utt: number }) => void;
  onTiming?: (e: TimingMark & { armId: string }) => void;
  onUtteranceComplete?: (e: { armId: string; record: UtteranceCompletion }) => void;
  onError?: (e: TransportError & { armId: string }) => void;
  onConnectionState?: (e: { armId: string; state: ConnectionState; attempt?: number }) => void;
}

export class ArmRouter {
  get armIds(): string[] {
    throw new Error('not implemented');
  }

  getArm(_armId: string): InterpreterTransport | undefined {
    throw new Error('not implemented');
  }

  addArm(_transport: InterpreterTransport): void {
    throw new Error('not implemented');
  }

  removeArm(_armId: string): void {
    throw new Error('not implemented');
  }

  sendAudio(_chunk: Int16Array): void {
    throw new Error('not implemented');
  }

  setHandlers(_handlers: ArmRouterHandlers): void {
    throw new Error('not implemented');
  }

  stopAll(): void {
    throw new Error('not implemented');
  }
}
