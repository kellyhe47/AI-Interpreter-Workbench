/**
 * STUB (ticket 001, test-first) — frozen arm definitions and derived armTag.
 *
 * Isomorphic TypeScript: compiled by BOTH tsconfig.json (DOM) and
 * tsconfig.server.json (node), so no node-only or DOM-only imports.
 *
 * No implementation yet — types and empty values only, so arms.test.ts can
 * import and typecheck. The tests are expected to FAIL against this file.
 */
import type { Mode } from './timing';

export type ArmTag = 'A' | 'B' | 'C' | 'ad-hoc';

/** Provider triple for a cascade configuration. Values are MODEL ids (see MENUS). */
export interface ProviderTriple {
  stt: string;
  mt: string;
  tts: string;
}

export interface RunConfig {
  architecture: Mode;
  /** Realtime model id; only meaningful when architecture === 'realtime'. */
  realtimeModel?: string;
  /** Required when architecture === 'cascade'. */
  providers?: ProviderTriple;
}

export interface ArmDefinition {
  tag: 'A' | 'B' | 'C';
  label: string;
  description: string;
  /** The frozen recipe. */
  config: RunConfig;
}

export const REALTIME_MODEL: string = '';

export const DEFAULT_CASCADE_TRIPLE: ProviderTriple = { stt: '', mt: '', tts: '' };

export const MENUS: { stt: readonly string[]; mt: readonly string[]; tts: readonly string[] } = {
  stt: [],
  mt: [],
  tts: [],
};

export const ARMS: readonly ArmDefinition[] = [];

export function deriveArmTag(config: RunConfig): ArmTag {
  void config;
  throw new Error('not implemented');
}

export function armLabel(tag: ArmTag): string {
  void tag;
  throw new Error('not implemented');
}
