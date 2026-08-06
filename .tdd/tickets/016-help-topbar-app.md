---
id: 016
title: Help view, four-tab TopBar, App routes four views
status: green
depends_on: [012, 013, 015]
touches: [src/client/views/HelpView.tsx, src/client/views/HelpView.test.tsx, src/client/components/TopBar.tsx, src/client/App.tsx, src/client/views/App.test.tsx, src/client/browserDeps.ts, src/client/fixtureDeps.ts, src/client/state/ledger.ts]
iterations: 0
test_files: [src/client/views/App.test.tsx, src/client/views/HelpView.test.tsx]
branch: ""
---

## Scope

The shell that ties v2 together.

- **ADD `src/client/views/HelpView.tsx`** — six plain-language cards (design README §Help).
- **MODIFY `src/client/components/TopBar.tsx`** — four tabs: **Live · Replay · Results ·
  Help**, with the pulsing live-session indicator on the right while a Live session is running.
- **MODIFY `src/client/App.tsx`** — route the four views over one shared deps bag, so the
  ledger a Live session appends to is the same instance Results reads.

## Help cards (copy from the mock; plain language is the point)

1. **What we're researching** — the sealed box vs the assembly line.
2. **Live vs Replay — the two modes**, including the three-entity explainer: a **Recording**
   is an input, a **Run** is one execution of a Recording through one configuration, a
   **LiveSession** is a real conversation's metrics — and LiveSessions and Runs are never
   compared, because they have different inputs and no shared basis.
3. **The three arms** — *"You never label a run yourself — the app derives the tag from what
   you actually configured."*
4. **The experiments** — the four questions, ending on the non-pooling rule: *"These tracks are
   never mixed: a Cantonese finding is never evidence about Spanish speed."*
5. **How to use it** — the four numbered steps (Live → Replay → Run/Batch → Compare blind).
6. **How to read it** — p50/p95, cost slope, provenance lines, and the "illustrative" badges.

## Inherited from ticket 014 — this ticket owns the wiring

014 extended `ReplayDeps` with three **optional** fields:

```ts
rng?: () => number;
evaluatorLanguage?: string;
recordBlindComparison?: (comparison: BlindComparison) => void;
```

They are optional only so ticket 013's locked `ReplayView.test.tsx` object literal keeps
type-checking. The pinned consequence: **a host supplying none of them gets no blind-compare
trigger at all** — absent, not disabled. That is a deliberately quiet failure mode, so it needs a
test here rather than a hope: **App must supply all three**, and a test must assert the trigger is
actually reachable through the real `<App />`. Without that, blind scoring silently would not
exist and every suite would still be green.

Also inherited: **`RunLedger` has no `recordBlindComparison` method.** 014 added the
`BlindComparison` type additively but no persistence. This ticket either adds that method to the
ledger (strictly additive — all 63 `ledger.test.ts` tests are locked and must stay green) or wires
`recordBlindComparison` to whatever else persists it. Say which in the implementation.

## Acceptance criteria

- [ ] TopBar renders exactly four tabs in order: Live, Replay, Results, Help
- [ ] Clicking each tab mounts that view and **exactly one view is mounted at a time**
- [ ] The default view on load is **Live**
- [ ] The live-session indicator appears only while a Live session is actively running, and
      **persists while the user is on another tab** (a session keeps running when you navigate
      to Replay) — it reflects session state, not which tab is open
- [ ] Session state survives tab switches: navigating Live → Results → Live does not reset the
      machine
- [ ] All four views share ONE deps bag, so a Live session's appended records are immediately
      visible on Results without a reload
- [ ] Replay and Results remain usable while Live is in `permission-denied` — the blocking mic
      card blocks the Live session, not the app
- [ ] HelpView renders six cards, including the three-entity explainer, the derived-tag
      statement and the non-pooling statement
- [ ] Styling uses tokens only; the topbar is 52px and sticky
- [ ] **App supplies `rng`, `evaluatorLanguage` and `recordBlindComparison` to `ReplayView`**, and
      the blind-compare trigger is reachable through the real `<App />` on a Recording with two
      completed runs — the optional deps must not silently disable the feature
- [ ] A submitted blind comparison is **persisted** — the drawn order, both dimensions for both
      samples, the two run ids and the evaluator language survive into the ledger

## Test plan

Rework `src/client/views/App.test.tsx` for four-view routing and add `HelpView.test.tsx`.
The TopBar tab set is currently two — survey for stale two-tab pins across the client tests
before writing.

## Attempt log

- iter 1: green. 24 tests (15 App + 9 Help). Mutation-checked: reintroducing the
  `view === 'live' &&` gate fails the navigate-away test.
- Killed a real bug: App gated the live indicator on being ON the Live tab, so a running session
  — still burning its 5-minute budget — showed no indicator once you opened Replay.
- App fills `rng` / `evaluatorLanguage` / `recordBlindComparison` itself rather than passing the
  host bag through, so the optional trio cannot silently disable blind scoring in the shipped app.
- `browserDeps`/`fixtureDeps` gained real `buildReplayDeps()`. Fixture mode deliberately uses the
  REAL replay deps: fixture mode exists because a QA browser has no grantable microphone, and
  Replay needs no microphone — faking its seams would only hide the real server.
- Ledger's `blindComparisons` store is deliberately NOT in `LedgerExport`: that envelope's shape is
  pinned by locked round-trip tests, so export/import stayed untouched.
- ORCHESTRATOR ERROR: I ran the mutation check BEFORE checkpointing, and the `git checkout --`
  that reverted my sabotage also destroyed the implementer's uncommitted `App.tsx`. Damage was
  confined to that one file; the other five were committed immediately and the implementer redid
  it from context. Correct order is commit → mutate → revert, and it exists for exactly this.
