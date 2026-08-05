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
