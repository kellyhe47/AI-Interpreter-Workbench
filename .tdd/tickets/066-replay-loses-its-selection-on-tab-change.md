---
id: 066
title: Leaving Replay and returning clears the Recording selection while the sidebar still shows its run count
status: pending
source: spec-audit (verified)
depends_on: []
touches: [src/client/views/ReplayView.tsx, src/client/App.tsx]
iterations: 0
test_files: []
branch: ""
---

## Observed — re-verified 2026-08-08

`ReplayView.tsx:379` holds the selected Recording in a plain `useState<string | null>(null)` — not
lifted, not persisted, no localStorage, no URL, no context. (A repo-wide grep of non-test
`src/client` finds `localStorage` only under the `RunLedger` persistence seam; there is no
`sessionStorage`, no `useSearchParams`, no `history.pushState` anywhere.) `App.tsx` mounts exactly
one view at a time and unmounts the one you leave — `const [view, setView] = useState<WorkbenchView>('live')`
at `App.tsx:145`, and the rule is stated in its own header at `:10-12`.

So switching to Results and back:
- selection → `null` → `selectedRuns` (`ReplayView.tsx:497`) filters to `[]` → the list renders
  **"No Runs of this Recording yet."** (`RunsList.tsx:56`)
- Run and Batch sweep become disabled (both guards early-return on `selectedRecordingId === null`)
- **but the sidebar still reads `3 runs`**, because `runCounts` (`ReplayView.tsx:487-490`) is built
  from the full `runs` array with no reference to the selection, and
  `RecordingsLibrary.tsx:445-446` renders it per Recording row unconditionally

The screen therefore contradicts itself: the library says the Recording has runs, the panel says it
has none.

## Acceptance criteria

- [ ] After `Replay → Results → Replay`, the previously selected Recording is still selected —
      assert its row in `RecordingsLibrary` still carries the selected marker AND
      `[data-recording-run-count]` on that row and the Runs list agree
- [ ] After that same round-trip the Runs list renders the same run cards it rendered before
      leaving, not `No Runs of this Recording yet.`
- [ ] After that same round-trip `Run` and `Batch sweep…` are both enabled (they were enabled before
      leaving) and neither carries the no-selection `title` hint
- [ ] A persisted selection naming a Recording absent from the loaded library resolves to
      "no selection" — the empty-library/idle panel — and never leaves a row marked selected or a
      disabled-with-stale-id control
- [ ] A persisted selection naming a **soft-deleted** Recording (`deletedAt !== undefined`, filtered
      out of `visibleRecordings` at `ReplayView.tsx:494`) behaves the same way
- [ ] `No Runs of this Recording yet.` renders **only** when a Recording is selected and its
      `runCounts` entry is 0 — assert the two never disagree, in both the has-runs and the
      zero-runs case

> already satisfied: "The selection survives a tab round-trip" as a bare statement — split above
> into the four separately-observable consequences (row marker, runs list, control enablement,
> count agreement), because a fix can restore any one of them without the others.

## Out of scope

- Persisting the **open tab** across a reload. `App.tsx:145` defaults to `'live'` deliberately.
- Persisting any other Replay state — `config` (`ReplayView.tsx:380`), blind-compare toggle, in-flight
  sweep. Selection only.
- Changing `App.tsx`'s one-view-at-a-time rule. Keeping views mounted would "fix" the symptom and
  break the contract at `App.tsx:10-12` (nothing off-screen keeps polling or playing).
- Making the sidebar count selection-aware. The count is correct; the panel is what goes wrong.
- Recording deletion / soft-delete semantics themselves.

## Notes
- Persisting to the URL also makes a Recording linkable, which helps the write-up cite one.

## CONTEXT FOR A FRESH AGENT

### 1–2. Verified citations, with the code

`src/client/views/ReplayView.tsx:379` — the state that is lost.
```ts
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(null);
```

`src/client/views/ReplayView.tsx:486-497` — the count and the filter, side by side.
```ts
  /** Every Run, failed included — a failure is a Run like any other. */
  const runCounts: Record<string, number> = {};
  for (const run of runs) {
    runCounts[run.recordingId] = (runCounts[run.recordingId] ?? 0) + 1;
  }

  // A soft-deleted Recording leaves the library but stays reachable, so its
  // Runs keep a label and a duration to normalize their cost by.
  const visibleRecordings = recordings.filter((recording) => recording.deletedAt === undefined);
  const selectedRecording =
    recordings.find((recording) => recording.id === selectedRecordingId) ?? null;
  const selectedRuns = runs.filter((run) => run.recordingId === selectedRecordingId);
```
`runCounts` is passed at `:693`, `selectedRecordingId` at `:694`.

`src/client/components/replay/RecordingsLibrary.tsx:43-45` (props), `:352` (`const selected =
recording.id === props.selectedRecordingId`), `:363` (`onClick={() => props.onSelect(recording.id)}`),
`:445-446` — the count that keeps talking:
```tsx
                  <span data-recording-run-count="">
                    {`${props.runCounts[recording.id] ?? 0} runs`}
```

`src/client/components/replay/RunsList.tsx:56` — `const EMPTY = 'No Runs of this Recording yet.';`

`src/client/App.tsx:10-12` — the unmount rule (header comment).
```
 * - EXACTLY ONE VIEW IS MOUNTED. Tabs are not panels: switching tab unmounts
 *   the view you left, so nothing off-screen keeps polling, playing or
 *   holding a stale copy of the ledger.
```
`src/client/App.tsx:145` — `const [view, setView] = useState<WorkbenchView>('live');`
`src/client/App.tsx:332` — `<TopBar view={view} onViewChange={setView} … />`

### 3. Existing test files — where this ticket's tests must land

STANDING POLICY: no new test file in a module that already has one.

- The tab round-trip needs `<App>`, so those tests go in **`src/client/views/App.test.tsx`**. It
  already has the machinery: `TABS` (`:67`), `PROBE` (`:70-75`), `clickTab`/`showTab` (`:79-88`),
  `makeReplayDeps({ recordings, runs })` (`:155-198`) and `renderWorkbench` (`:211-214`). There is
  precedent for exactly this shape of test at `:298` ("PERSISTS while the user reads Replay,
  Results and Help mid-session").
- ReplayView-local behaviour (stale/soft-deleted id resolves to no selection; count-vs-list
  agreement) goes in **`src/client/views/ReplayView.test.tsx`**.
- Do **not** create `ReplayView.selection.test.tsx` or `App.selection.test.tsx`. `ReplayView.tsx`
  already has five test files (`test`, `failures`, `inflight`, `playbackFailure`, `record`) and
  `App.tsx` has six.

### 4. Seams

- The persistence store must be **injected**, not reached for directly. The precedent is
  `src/client/state/ledger.ts:382` (`/** localStorage-compatible subset used for persistence. */`)
  consumed at `src/client/browserDeps.ts:522` (`ledger: new RunLedger(window.localStorage)`).
  Follow that: a storage-shaped seam on the deps bag, real `window.localStorage` in `browserDeps.ts`
  only. `BrowserDeps extends SessionDeps` at `browserDeps.ts:94`.
- `src/client/fixtureDeps.ts` (`buildFixtureDeps`, `isFixtureMode`) must supply the seam too, or
  fixture mode diverges.
- `App.test.tsx:183-198` shows the minimal `ReplayDeps` bag the tests build — any new required seam
  must be added there or every App test fails at once.
- Not relevant: `src/client/views/sessionTestKit.ts`, `src/client/state/hydrationFixtures.ts`,
  `src/client/components/results/testRecords.ts`, `src/client/batch/runner.ts`.
- jsdom **does** provide `localStorage`, which is exactly why it is easy to bypass the seam here.
  jsdom has no AudioContext/MediaStream/RTCPeerConnection — never construct one.

### 5. Golden evals

**No golden eval applies to this ticket, and none should be forced.** All twelve concern measurement
integrity — aggregation gates, anchors, provenance, cost nulls, pacing, arm derivation. This is a
view-state defect that reports no number. Do not stretch
`01-server-ledger-is-the-only-aggregate-source.json` onto it; that one is about the LiveSession write
path, not about UI selection.

### 6. Known traps for this ticket

- **ACUTE — a selection that survives only because something else re-rendered.** `ReplayView` loads
  recordings and runs asynchronously (`loadRecordings` / `refreshRuns`, effect at `:484`), so a
  remount fires fresh fetches that land after the assertion. A test that `await`s the library and
  then reads the panel can pass on a race, not on persistence. Pin it: assert the selected row's
  marker **and** the Runs list content in the same `waitFor`, and assert the *identical* run ids
  present before the round-trip. Better still, assert the restore happens without a second
  `recordings.list()` result — i.e. that the id came from the store, not from a refetch.
- **ACUTE — comparing a render against itself.** RTL **appends** to `document.body` and `App.test.tsx`
  accessors are global `document.querySelector` (`q`/`get`). Leaving Replay unmounts it, but a stray
  earlier render still answers `q('[data-replay-view]')` and the "selection survived" assertion reads
  the *first* mount's DOM. `cleanup()` between renders; better, do the whole round-trip inside one
  `render(<App/>)` via `showTab('Results')` then `showTab('Replay')`, never by re-rendering.
- **A fix with zero production callers.** Adding a `selectionStore` to `ReplayDeps` and testing the
  store in isolation, while `ReplayView` still initialises `useState(null)`, changes nothing on
  screen. The binding assertion is the DOM after the round-trip, not the store's contents.
- **The bypass.** `useState(deps.selection!.get())` or `(deps as any).selection?.get()` silently
  no-ops when the seam is absent, and `App.test.tsx`'s deps bag *is* absent by default — so the whole
  feature is dead in tests while the type-checker is satisfied. Make the seam required, or make its
  absence an explicit "no persistence" path with its own test.
- **The stale-id path is where the contradiction moves, not disappears.** Restoring an id whose
  Recording is gone reproduces the exact bug in reverse: a selected id with no row. `selectedRecording`
  at `:495-496` searches `recordings` (all), while `visibleRecordings` at `:494` excludes soft-deleted
  ones — so a soft-deleted id yields a non-null `selectedRecording` with no visible row. Handle both.
- Do not "fix" this by keeping every view mounted in `App.tsx`. That trades a display bug for a
  contract violation (`App.tsx:10-12`) and for background polling.

### Standing project rules

- `isAggregatableRun` is the ONE place that decides aggregation — never add a second gate.
- Arm membership is DERIVED from configuration, never declared.
- Unmeasured is `null` and renders `not measured` — never `$0.00`, never a zero.
- Never report a fixture-sourced number; never aggregate a run whose `origin` is `manual` or
  `status` is `failed`.
- The measured atom is the UTTERANCE, not the Run.
- 24 kHz PCM16 mono everywhere; `SAMPLE_RATE` in `src/core/protocol.ts` is the single source of truth.
- Live persists no audio and creates no Run records.
- Replay autoplays nothing; Live autoplays always.
