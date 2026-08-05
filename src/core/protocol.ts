/**
 * Cascade WebSocket wire protocol types.
 * Isomorphic TypeScript — no node/DOM imports.
 */

import type { Mode, UtteranceRecord } from './timing';

/** PCM sample rate used across the wire (16-bit mono). */
export const SAMPLE_RATE = 24000;

export type ClientToServerMessage =
  | {
      type: 'session.start';
      mode: Mode;
      languagePair: string;
      direction: string;
      providers: { stt: string; mt: string; tts: string };
    }
  | { type: 'audio.chunk'; data: string /* base64-encoded PCM16 @ SAMPLE_RATE */ }
  | { type: 'utterance.end' }
  | { type: 'session.end' };

export type ServerToClientMessage =
  | { type: 'stt.partial'; text: string }
  | { type: 'stt.final'; text: string }
  | { type: 'mt.delta'; text: string }
  | { type: 'mt.final'; text: string }
  | { type: 'tts.chunk'; data: string /* base64-encoded PCM16 @ SAMPLE_RATE */ }
  | { type: 'utterance.complete'; record: UtteranceRecord }
  | { type: 'error'; message: string };
