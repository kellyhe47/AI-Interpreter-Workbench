---
id: 012
title: Live rework — router switch, single architecture, LiveView
status: green
depends_on: [001, 010]
touches: [src/client/transport/router.ts, src/client/transport/router.test.ts, src/client/transport/types.ts, src/client/state/sessionMachine.ts, src/client/state/sessionMachine.test.ts, src/client/views/useSessionController.ts, src/client/views/LiveView.tsx, src/client/views/SessionView.tsx, src/client/views/SessionView.test.tsx, src/client/views/SessionView.flow.test.tsx, src/client/views/sessionTestKit.ts, src/client/browserDeps.ts, src/client/fixtureDeps.ts, src/client/fixtureDeps.test.ts, src/client/App.tsx, src/client/views/App.test.tsx]
iterations: 0
test_files: [src/client/views/LiveView.test.tsx, src/client/views/LiveView.flow.test.tsx, src/client/transport/router.test.ts, src/client/state/sessionMachine.test.ts, src/client/views/App.test.tsx, src/client/deletions.test.ts, src/client/views/sessionTestKit.ts, src/client/fixtureDeps.test.ts]
branch: ""
---

## Scope

The largest single change in v2. Live mode collapses from a multi-arm comparison grid to
**exactly one architecture per session** (PRD §17 19g), because comparison moved to Replay.
This ticket is indivisible: `useSessionController` is imported by `App`, `SessionView`,
`browserDeps`, `fixtureDeps` and `sessionTestKit`, so the rework lands in one piece or the
suite is red in between.

Files:
- **`src/client/transport/router.ts`** — fan-out → switch
- **`src/client/transport/types.ts`** — drop arm/multi-transport typing the router relied on
- **`src/client/state/sessionMachine.ts`** — drop multi-arm state
- **`src/client/views/useSessionController.ts`** — the rework proper
- **`src/client/views/SessionView.tsx` → renamed `src/client/views/LiveView.tsx`** (`git mv`
  is the orchestrator's job — just create `LiveView.tsx` and delete `SessionView.tsx`; tests
  rename with it)
- **`src/client/browserDeps.ts`, `fixtureDeps.ts`, `views/sessionTestKit.ts`** — follow the
  controller
- **`src/client/App.tsx`** — update the import/route for the rename only. The four-tab shell
  is ticket 016; keep App otherwise as-is so the suite stays green.

## DELETE (manifest DELETE table — must actually be gone)

- `ARM_CATALOG` multi-select, the `CASCADE_PROVIDERS` preset map, `ADD_ORDER`, and the
  add/remove-arm actions in `useSessionController.ts`
- Fan-out routing and per-arm event multiplexing in `transport/router.ts`
- Audible-arm selection, the "two arms would talk over each other" state, the add-arm
  affordance and the multi-column arm grid in the Live view
- The `stt: 'deepgram'` reference at `views/sessionTestKit.ts:113` — a vendor that was cut

## Router: switch, not fan-out (§17 19b · 24a)

One active transport at a time. `setActive(transport)` replaces the current one (stopping it),
`sendAudio` goes to that one transport, and events come back **without an `armId`** — there is
no arm to disambiguate. Fan-out existed to guarantee identical live input across arms; a saved
Recording does that better and without concurrent-network contention, so the router goes back
to being a switch.

## Session machine

The state set is already correct (`idle · requesting-permission · permission-denied ·
listening · processing · ready · playing · reconnecting · disconnected · stopping · stopped`)
and `permission-denied` already blocks session start. What changes:

- **Remove** `arms[]`, `ADD_ARM`, `REMOVE_ARM` and the multi-arm autoplay invariants. **Live
  autoplay is on, unconditionally** — one architecture means nothing to collide with.
- **Add** the cascade per-stage selection (`providers: {stt, mt, tts}`, defaulting to
  `DEFAULT_CASCADE_TRIPLE` from `src/core/arms.ts`) and **`contextPolicy: 'default' |
  'trimmed'`**, which is Live-only and Realtime-only.
- **Keep** the `pending` switch-queue overlay and its boundary rule, extended so **mode, pair
  AND direction** all queue at the utterance boundary. One mechanism, three triggers.

**Judgement call to preserve:** PRD §7's table lists `switch-queued` as a state, but the
existing machine models it as a `pending` overlay carried alongside an active status — which
is strictly more expressive (you can be processing *and* have a switch queued) and matches the
design mock's `pending`. Keep the overlay; expose a derived `switch-queued` label for the UI so
the PRD's visible-state requirement is met.

## LiveView (design README §Live)

- Purpose line: *"One architecture, voice in → voice out, up to 5 minutes. Metrics are saved;
  audio is discarded. Nothing here becomes experimental evidence."*
- Controls card: Realtime/Cascade segmented toggle · **derived-arm pill** ("this is Arm A/B/C"
  accent-soft, "ad-hoc" gray — derived from config via `deriveArmTag`, never user-set) ·
  language pair · direction swap · per-direction support pill · Start/Stop. Second row:
  Cascade → per-stage model selectors; Realtime → context-policy toggle with its cost note.
- Status strip: **four-value** mic permission (`not-requested` muted / `requesting` /
  `granted` green / `denied` red) — never hardcoded, never optimistic; connection; 5-bar input
  meter; state (mono); elapsed `M:SS / 5:00 · autoplay on`.
- Banners: switch-queued (amber, *"switching to X after this sentence finishes"*);
  reconnecting with attempt count; disconnected (red, attempts exhausted, history intact,
  Reconnect); Cantonese-output-on-Realtime warning (**warns, never blocks**); stopped (green,
  *"LiveSession metrics saved — audio discarded"*).
- Permission-denied card is **blocking** and must cover **both** remediation layers (site
  permission and OS permission) — browsers do not re-prompt after a denial, so a bare retry
  button appears to do nothing (PRD §7 mic requirements 3 and 4). Replay/Results stay usable.
- Session cards: source transcript; **one** target card (not a grid) with architecture name,
  in-flight indicator, failed state with **architecture-differentiated copy** (cascade names
  the stage; Realtime is opaque — this asymmetry is a PRD finding, not incidental copy), and
  **labelled per-stage milliseconds** (5 cascade / 3 realtime with the model interval labelled
  opaque). Numbers, not bars alone.
- **The mock's "Mock state" chips are a review-only simulator and must NOT be built** — real
  states come from the machine (AGENTS.md).
- Live ends at **5 minutes**; metrics are saved as a `LiveSession` and **the audio is
  discarded**. `quality.wer` is always null in a LiveSession — free conversation has no
  reference transcript.

## Acceptance criteria

- [ ] `ArmRouter` (or its successor) exposes a single active transport: setting a new one stops
      the previous, `sendAudio` reaches only the active transport, and events arrive without an
      `armId`. `addArm`/`removeArm`/fan-out are gone
- [ ] Audio sent while no transport is active is a no-op, not a throw
- [ ] `ARM_CATALOG`, `CASCADE_PROVIDERS`, `ADD_ORDER`, add/remove-arm actions and the string
      `'deepgram'` do not appear anywhere under `src/client/` (assert by grep in a test or by
      absence of the exported symbols)
- [ ] The machine has no `arms` array and no ADD_ARM/REMOVE_ARM events; autoplay is always true
      in Live
- [ ] The machine carries `providers` (defaulting to Arm B's triple) and `contextPolicy`
      (`'default' | 'trimmed'`, Realtime only)
- [ ] A mode switch requested **mid-utterance** queues and applies at the next utterance
      boundary; the same holds for a language-pair switch and for a direction swap. Requested
      at a boundary (listening/ready), each applies immediately
- [ ] The derived-arm pill shows "this is Arm B" for Arm B's triple and "ad-hoc" off-arm,
      computed via `deriveArmTag` — there is no control anywhere that sets a tag directly
- [ ] Mic permission renders all four values and reflects the live value; `denied` renders the
      blocking card naming **both** the site and OS remediation layers, and Start is blocked
      while denied (clicking retry does not re-invoke capture, matching browser behaviour)
- [ ] The Cantonese-output-on-Realtime warning appears when the **target** is Cantonese and
      Realtime is active, and **never blocks** starting or running the session
- [ ] Cascade failure copy names the failing stage; Realtime failure copy is opaque with no
      stage attribution. Both keep the session running
- [ ] Per-stage latency renders as **labelled milliseconds**: 5 intervals for cascade, 3 for
      realtime with the model interval explicitly labelled opaque
- [ ] Exactly one target card renders — no multi-column arm grid, no add-arm affordance, no
      audible-arm selector
- [ ] The session ends at 5 minutes; the elapsed display reads `M:SS / 5:00`
- [ ] On stop, a `LiveSession` is saved with metrics and **no audio**, and `quality.wer` is null
- [ ] Session footer figures come from the ledger aggregate for the session, never from a
      hardcoded or illustrative figure
- [ ] `?fixture=1` / `?fixture=fail-mt` browser fixture mode still works and still produces
      fixture-named providers so its records stay out of aggregates

## Orchestrator note — realtime model snapshot (added after ticket 001)

`REALTIME_MODEL` is `gpt-realtime` (Arm A's frozen recipe, which the rubric requires), but the
existing transport and token defaults are `gpt-realtime-mini` — the PRD §5 / §14 **development**
model, chosen for cost control. `deriveArmTag` therefore tags a mini-model run `ad-hoc`, and that
is **correct**: a cheap dev run must not count as Arm A evidence. That is the quarantine working.

The consequence to handle here: **this ticket must pass the realtime model explicitly from the run
configuration** rather than letting the transport fall back to its dev default — otherwise every
realtime run derives `ad-hoc` and Arm A never appears in the ledger. `src/server/token.ts` and
`src/client/transport/realtime.ts` keep `gpt-realtime-mini` as their default; the caller supplies
`REALTIME_MODEL` for measured runs.

## Test plan

Rename `SessionView.test.tsx` / `SessionView.flow.test.tsx` to `LiveView.*` and drop the
multi-arm and fan-out assertions (manifest Tests table). Rework `router.test.ts`
(fan-out → switch) and `sessionMachine.test.ts` (no arms). Update `sessionTestKit.ts`,
`fixtureDeps.test.ts`, `App.test.tsx`. **Survey the whole client test tree for pins of the old
multi-arm behaviour before writing** — a stale pin in a sibling file becomes an irreconcilable
locked-vs-locked conflict.

## Attempt log

- iter 1: green. 52 new RTL tests through the real <App />, plus the reworked router (11) and
  machine (74). deletions.test.ts 11/11 — the manifest DELETE list is now enforced tree-wide.
- ORCHESTRATOR ERROR, caught and fixed: the worktree `node_modules` symlink I created got
  committed by `git add -A .` (`.gitignore` had `node_modules/` WITH a trailing slash, which does
  not match a symlink). Merging replaced main's real node_modules with a self-referencing link and
  vitest died with `too many levels of symbolic links`. Untracked the symlink, added a
  slash-less `node_modules` rule to .gitignore, reinstalled. Audited every commit in the run: this
  was the only occurrence, no other symlink is tracked, and no .env ever entered a commit.
