/**
 * STUB (ticket 003 — test-writer). Recordings REST router.
 *
 * Contract pinned by src/server/routes/recordings.test.ts; the implementation
 * belongs to the implementer. See that file for the normative wire shapes.
 */
import { Router } from 'express';

import type { Storage } from '../storage';

export interface RecordingsRouterDeps {
  /** Injected so tests never touch the repo's data/ directory. */
  storage: Storage;
}

export function createRecordingsRouter(deps: RecordingsRouterDeps): Router {
  void deps;
  return Router();
}
