/**
 * STUB (ticket 003 — test-writer). Runs REST router.
 *
 * Contract pinned by src/server/routes/runs.test.ts; the implementation
 * belongs to the implementer.
 */
import { Router } from 'express';

import type { Storage } from '../storage';

export interface RunsRouterDeps {
  /** Injected so tests never touch the repo's data/ directory. */
  storage: Storage;
}

export function createRunsRouter(deps: RunsRouterDeps): Router {
  void deps;
  return Router();
}
