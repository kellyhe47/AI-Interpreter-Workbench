/**
 * Realtime ephemeral token endpoint (Ticket 005).
 *
 * ============================ API DESIGN (normative) =======================
 * createTokenRouter(deps?) returns an express.Router exposing
 *   POST /api/realtime-token   body: { model?: string }
 *
 * Behavior (checked in this order):
 *  1. model defaults to DEFAULT_REALTIME_MODEL; if the (explicit) model is
 *     not in REALTIME_MODEL_ALLOWLIST -> 400 {error} (error names the model).
 *  2. process.env.OPENAI_API_KEY missing/empty -> 500 {error}.
 *  3. Otherwise POST https://api.openai.com/v1/realtime/client_secrets with
 *     headers { Authorization: `Bearer ${OPENAI_API_KEY}`,
 *               'Content-Type': 'application/json' }
 *     and JSON body:
 *       { session: { type: 'realtime', model,
 *                    audio: { output: { voice: 'alloy' } } } }
 *     On upstream ok: respond 200 with the upstream JSON body (which
 *     contains { value, expires_at, ... }). On upstream non-ok: mirror the
 *     upstream status with {error}.
 *
 * INJECTABILITY: the fetch implementation is a constructor dependency —
 * createTokenRouter({ fetchImpl }) — defaulting to globalThis.fetch. Tests
 * pass a mock; no module-level mutable state.
 *
 * The router needs express.json() body parsing; it mounts its own json
 * middleware so callers can simply `app.use(createTokenRouter())`.
 * ==========================================================================
 */

import { Router } from 'express';

export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-mini';
export const REALTIME_MODEL_ALLOWLIST = ['gpt-realtime', 'gpt-realtime-mini'] as const;
export const REALTIME_TOKEN_PATH = '/api/realtime-token';

export interface TokenRouterDeps {
  /** Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export function createTokenRouter(deps?: TokenRouterDeps): Router {
  void deps;
  const router = Router();
  router.post(REALTIME_TOKEN_PATH, (_req, _res) => {
    throw new Error('not implemented');
  });
  return router;
}
