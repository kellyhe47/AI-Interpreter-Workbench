---
id: 003
title: Recordings & Runs REST routes, mounted; ws passes run identity
status: pending
depends_on: [002]
touches: [src/server/routes/, src/server/index.ts, src/server/index.test.ts, src/server/ws.ts, src/server/ws.test.ts]
iterations: 0
test_files: []
branch: ""
---

## Scope

**ADD `src/server/routes/`** — express routers over the ticket-002 storage layer, following
the shape of the existing `createTokenRouter()` in `src/server/token.ts` (a factory returning
a `Router`, with its dependencies injectable so tests never touch the real `data/` dir).

**MODIFY `src/server/index.ts`** — mount the new routers alongside `createTokenRouter()`.
Static SPA serving and the `/api/health` route are unchanged.

**MODIFY `src/server/ws.ts`** — keep the WS cascade path exactly as-is; add nothing beyond
threading the `recordingId` / `runId` / `origin` from `session.start` (ticket 002's protocol
fields) through to the record the server produces. This is deliberately a small change: the
orchestrator, turn-final handling and per-stage timing capture are KEEP files and the v2
model does not change how a cascade utterance is processed.

## Endpoints (PRD §7 — normative)

| Method | Path | Behaviour |
|---|---|---|
| POST | `/api/recordings` | browser uploads recorded audio + metadata, returns the created Recording (with id) |
| GET | `/api/recordings` | list, excluding soft-deleted |
| GET | `/api/recordings/:id` | one Recording |
| GET | `/api/recordings/:id/audio` | the WAV bytes, `Content-Type: audio/wav` |
| PATCH | `/api/recordings/:id` | edit the label — and only the label |
| DELETE | `/api/recordings/:id` | soft delete; **409 for a corpus Recording** |
| POST | `/api/runs` | append a Run record (client-produced for Realtime, per PRD §7) |
| GET | `/api/runs` | list; `?recordingId=` filters |
| GET | `/api/runs/:id/audio` | the run's output WAV |

Paths are `/api/...` because `src/server/index.ts` already excludes `/api/` and `/ws/` from
the SPA catch-all; anything else would be swallowed by `index.html`.

## Acceptance criteria

- [ ] `POST /api/recordings` with audio + metadata returns 201 and a body carrying a
      generated `id`; a follow-up `GET /api/recordings/:id/audio` returns the identical bytes
- [ ] `GET /api/recordings` returns created Recordings and **omits soft-deleted ones**
- [ ] `PATCH /api/recordings/:id` with a new label returns the updated Recording; a request
      attempting to change `durationMs`, `speechEndMs`, `origin` or audio does **not** change
      them (audio is immutable — PRD §7)
- [ ] `DELETE` on a `mic` Recording returns 2xx and the Recording disappears from the list
      while its Runs remain retrievable via `GET /api/runs?recordingId=`
- [ ] `DELETE` on a `corpus` Recording returns **409** with a message naming the reason, and
      the Recording is still listed
- [ ] `GET /api/recordings/:id` for an unknown id returns **404** (not a 500)
- [ ] `GET /api/recordings/:id/audio` where the WAV is missing returns **404/410 with a
      machine-readable reason**, not an unhandled throw — the client marks the Recording
      unplayable and blocks new runs against it (PRD §12)
- [ ] `POST /api/runs` appends a Run and returns it; `GET /api/runs` lists it; a run posted
      with `status: 'failed'` is stored and listed exactly like a complete one
- [ ] `GET /api/runs?recordingId=X` returns only that Recording's runs
- [ ] Posting the same Run twice does not rewrite an earlier ledger line — the store is
      append-only
- [ ] `GET /api/health` still returns `{ok:true}` and the token route still works — the new
      mounts do not shadow existing routes
- [ ] In production mode the SPA catch-all still serves `index.html` for a non-`/api/` path
      and does **not** intercept `/api/recordings`
- [ ] `session.start` carrying `recordingId` / `runId` / `origin` is accepted by the WS
      handler and those values appear on the record it emits; `session.start` **without**
      them still works exactly as before (Live sends none of the three)

## Test plan

Extend `src/server/index.test.ts` (it already boots the app server on an ephemeral port) and
`src/server/ws.test.ts`. Storage is injected with a temp-dir-backed store, so no test writes
into the repo's `data/`.

## Attempt log
