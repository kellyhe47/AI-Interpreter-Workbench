# QA report — iterations 5 & 6 — CONVERGED (two consecutive clean passes)

Iteration 5 (post-022): idle Realtime default · deny path w/ frozen 00:00 timer ·
fixture session: instant ready-switch (arm swap, no banner), continuous numbering, add arm
mid-session joins the SHARED utterance timeline (both cards translate the same sentence —
verified concurrently mid-stream and at ready), blind compare full cycle, remove-arm autoplay
restore, stop summary real numbers, Results still empty, zero console errors. **CLEAN.**

Iteration 6: fail-mt journey — cascade card 'failed' with exact copy "mt stage timed out for
this utterance — session still running" at the injected utterance, session recovers and
streams the next utterance normally; shared timeline holds under the fault; stop; Results
empty; zero console errors. Deny + idle re-checked. **CLEAN.**

Verdict: the QA loop converged at iteration 6 (findings across the run: 7 filed, 7 fixed and
verified in-browser). Standing escalations: real-microphone journeys and real-provider
end-to-end audio remain unverified in a browser (pane blocks capture; provider paths were
smoke-tested at the adapter level). These need the operator.

---

# QA report — iterations 3 & 4

Iteration 3 (post 019–021 fixes): **CLEAN PASS #1.** Re-walked: idle (Realtime default),
deny (timer frozen 00:00), fixture session — switch-in-ready instant w/o banner + arm swap;
switch-mid-stream banner → applied exactly at settle w/ continuous utterance numbering;
per-utterance card reset; script loops past 8 (observed utterance 13); stop; Results empty;
zero console errors. No new findings.

Iteration 4 (full re-walk): deny/warnings/timer all hold; add-arm, blind compare full cycle
(submit gated on both scores — reasonable, not filed), remove-arm autoplay restore, stop
summary, Results empty — all pass. **One new finding:**

### QA-7 [low, fixture-mode] Arm playlists unsynchronized — concurrent arms display different utterances
- Repro: fixture session → add 2nd arm mid-session → arm cards show translations of two
  DIFFERENT source sentences (each transport runs its own schedule; offset persists across
  the session; blind compare pairs different sentences).
- Expected: PRD §6 — the same source feeds every arm; fixture mode should present one shared
  utterance timeline across arms (identical utt id + source concurrently), or QA of
  comparison-mode semantics is misleading.
- Ticket: 022-qa-fixture-shared-timeline.md

---

# QA report — iteration 2

```yaml
sha: (post 016-018 fixes)
branch: main
tree: dirty (RUN_LOG only)
launched: npm run dev (reused) → http://localhost:5173 (+ ?fixture=1 / ?fixture=fail-mt)
```

## Verified fixed from iteration 1
- QA-1 (016): denied-state elapsed frozen at 00:00 over 3+ s. ✓
- QA-2 (017): cold open defaults Realtime; subline '… · Realtime · autoplay on.' ✓
- QA-3 (018): ?fixture=1 drives the full live UI with no mic and no keys. ✓

## Flows walked (all via fixture mode unless noted)
- Idle → deny (real block) → remediation card ✓ · Idle → fixture grant → listening →
  transcripts streaming (partials then finals, target deltas) ✓ · arm card in-flight →
  ready with labelled mono ms (realtime 3 rows + opaque note; cascade 5 rows) ✓ ·
  add arm (2-col, priced pill, autoplay-off note, shared suffix) ✓ · blind compare full
  cycle (hidden → score 4/5 → submit → identities revealed, hints/labels exact) ✓ ·
  remove arm restores autoplay ✓ · stop → green summary with real numbers, frozen elapsed,
  history intact ✓ · fail-mt → cascade card 'failed' with EXACT stage-attributed copy,
  session continues ✓ · Results after fixture session → still 'No runs recorded' ✓ ·
  console: zero errors throughout.

## New findings

### QA-4 [medium] Queued mode switch never applies; banner stuck indefinitely
- Repro A: fixture session, single arm, state `ready` between utterances → click Cascade →
  banner 'switching to Cascade after this sentence finishes' → banner persists ≥60 s across
  later utterance completions; mode never changes.
- Repro B: same but clicked while an utterance was actively streaming → utterance settled →
  banner still present, mode unchanged.
- Expected: PRD §6 — switch "queues and applies at the next utterance boundary"; and when no
  utterance is in flight there is no sentence to finish, so the switch should apply
  immediately.
- Ticket: 019-qa-switch-never-applies.md

### QA-5 [low] Arm card shows a previous utterance's translation labelled 'ready'
- Repro: fixture session; when an arm has produced nothing for the current utterance, its card
  keeps the prior utterance's target text + 'ready' while the source card has advanced (seen
  3 utterances apart).
- Expected: per-arm state is per-utterance (PRD §6 table); a card should show in-flight/empty
  for the current utterance, not stale content labelled ready.
- Ticket: 020-qa-stale-arm-card.md

### QA-6 [low, fixture-mode] Script exhaustion wedges the session in 'processing'
- Repro: let the 8-utterance fixture script run out mid-utterance → status strip stays
  'processing' forever; no settle, no error.
- Expected: fixture transport should loop its script (QA needs continuous utterances) or end
  the last utterance cleanly.
- Ticket: 021-qa-fixture-script-loop.md

Escalations: unchanged (real-mic + real-provider journeys).

---

# QA report — iteration 1

```yaml
sha: aa9a6c0
branch: main
tree: dirty            # only .gitignore/RUN_LOG/.claude launch config — no source changes
launched: npm run dev via .claude/launch.json → http://localhost:5173
```

Screenshot note: the embedded browser pane does not export image files; the screenshot trail
for this iteration lives in the run session (one screenshot per screen listed below). Paths in
`.qa/screens/` will populate in later iterations if a file-exporting browser is available.

## Flows walked

1. **Cold open → idle → Results → back** — WALKED. Idle card (copy exact), status strip
   (mic not requested / no connection / gray meter / idle / 00:00 · autoplay on), footer real
   (0 utterances, p50 —, p95 —, $0.00; no illustrative pill), no Mock-state chips. Results:
   empty state exact, disabled Run sweep, no sample figures, provenance mono only on Results.
   Live dot absent. ✓ except finding QA-2 (default mode).
2. **Start microphone (deny) → blocking card** — WALKED (pane hard-blocks mic → real
   NotAllowedError). Four-value indicator went not-requested → mic blocked (red);
   state mono `permission-denied`; blocking card "Microphone blocked" with site-permission
   layer, OS layer, and no-re-prompt guidance + Retry microphone. ✓ except finding QA-1
   (elapsed timer ticking).
3. **Language cycle → EN↔YUE warnings; direction swap** — WALKED. EN→Cantonese applied
   instantly while sessionless ✓; pill amber 'cascade only' ✓; Realtime + EN→YUE target warn
   banner copy exact ✓; swap → Cantonese→English input warn copy exact ✓; never blocked ✓.
4. **Mode toggle (idle/denied: instant apply)** — WALKED. Realtime↔Cascade applies instantly
   with no banner when sessionless. ✓
5. **Start (grant) → live session → transcripts → mid-session switch banner → stop summary** —
   HALTED at mic grant: pane cannot grant capture. See Escalations + finding QA-3.
6. **Comparison mode (arms strip, 2-col cards, labelled ms, blind compare)** — HALTED: requires
   an active session (arms strip is hidden while idle by design). Same blocker.
7. **Reconnect banners** — HALTED: requires live transport. Same blocker.

Console: zero errors across all walked screens.

## Findings

### QA-1 [medium] Elapsed timer runs while no session exists (permission-denied)
- Repro: open app → click Start microphone (mic blocked environment) → observe status strip.
- Observed: elapsed counts up (00:31 → 00:53 → 01:08) while state is `permission-denied` and
  no session ever started.
- Expected: PRD §6 lifecycle — elapsed timer belongs to `listening`+ states; idle shows 00:00
  (mock). A session that never started has no elapsed time.
- Ticket: 016-qa-elapsed-timer-denied.md

### QA-2 [low] Default mode is Cascade; design mock initializes to Realtime
- Repro: cold open → controls card.
- Observed: Cascade selected; idle subline "… · Cascade · autoplay on."
- Expected: mock logic class `state = {mode: 'realtime', arms: ['realtime']}`; handoff README
  presents Realtime as the default arm pill; PRD is silent → mock governs visuals/UX.
- Ticket: 017-qa-default-mode-realtime.md

### QA-3 [medium] No browser-drivable fixture mode — live-session journeys untestable without a real mic + live keys
- Repro: any journey needing `listening`+ (flows 5–7) in a browser without grantable mic.
- Observed: production deps only; all live-session UI is unreachable. RTL tests cover the flows
  with injected fakes, but no real-browser walk can observe them.
- Expected: PRD §7 "Fixtures … are used for development, CI, error-path tests, and long-running
  stability runs" and §7 benchmark harness drives the real SPA in a browser (fake audio
  device). A dev-only fixture mode (e.g. `?fixture=1` wiring FixtureTransport + fake capture
  through the existing deps seam) is the missing enabler for QA and the future Playwright
  harness.
- Ticket: 018-qa-browser-fixture-mode.md

### Noted, not filed
- Cantonese warnings render while idle/denied (mock gates them on an active session). Logged
  during build as a deliberate deviation: PRD only requires warn-never-block, and warning
  before start is more informative. Flagging for operator awareness only.

## Escalations
- **Mic-granted journeys** (flows 5–7): the pane's capture policy hard-blocks getUserMedia;
  cannot be driven here. Becomes drivable once QA-3's fixture mode exists (next iteration).
- **Real-provider audio journeys** (Arm A/B with live APIs): out of scope for QA per budget
  rules; adapters were smoke-tested separately.
