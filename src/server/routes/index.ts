/**
 * Barrel for the REST routers mounted by
 * src/server/index.ts.
 */
export { createRecordingsRouter } from './recordings';
export type { RecordingsRouterDeps } from './recordings';
export { createRunsRouter } from './runs';
export type { RunsRouterDeps } from './runs';
// Ticket 023 — the blind-comparisons router (QA F6).
export { createBlindComparisonsRouter } from './blindComparisons';
export type { BlindComparisonsRouterDeps } from './blindComparisons';
