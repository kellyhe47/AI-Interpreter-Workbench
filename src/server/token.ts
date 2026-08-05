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

import { json, Router } from 'express';

export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-mini';
export const REALTIME_MODEL_ALLOWLIST = ['gpt-realtime', 'gpt-realtime-mini'] as const;
export const REALTIME_TOKEN_PATH = '/api/realtime-token';

const OPENAI_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

export interface TokenRouterDeps {
  /** Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export function createTokenRouter(deps?: TokenRouterDeps): Router {
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
  const router = Router();

  router.post(REALTIME_TOKEN_PATH, json(), (req, res) => {
    void (async () => {
      const body = (req.body ?? {}) as { model?: unknown };
      const model =
        typeof body.model === 'string' && body.model.length > 0
          ? body.model
          : DEFAULT_REALTIME_MODEL;

      if (!(REALTIME_MODEL_ALLOWLIST as readonly string[]).includes(model)) {
        res.status(400).json({
          error: `model "${model}" is not allowed; allowed models: ${REALTIME_MODEL_ALLOWLIST.join(', ')}`,
        });
        return;
      }

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        res.status(500).json({ error: 'OPENAI_API_KEY is not configured on the server' });
        return;
      }

      try {
        const upstream = await fetchImpl(OPENAI_CLIENT_SECRETS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            session: {
              type: 'realtime',
              model,
              audio: { output: { voice: 'alloy' } },
            },
          }),
        });

        const upstreamBody: unknown = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          const err =
            (upstreamBody as { error?: unknown } | null)?.error ??
            `upstream token mint failed with status ${upstream.status}`;
          res.status(upstream.status).json({ error: err });
          return;
        }
        res.status(200).json(upstreamBody);
      } catch (err) {
        res.status(502).json({ error: (err as Error).message });
      }
    })();
  });

  return router;
}
