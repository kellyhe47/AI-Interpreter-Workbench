---
id: 012
title: Session view UI — full cockpit per design handoff
status: pending
depends_on: [008, 009, 010, 011]
touches: [src/client/App.tsx, src/client/components/*, src/client/views/SessionView.tsx]
test_files: []
iterations: 0
---

## Scope
Recreate the dc.html mock in React/TS with tokens.css vars (pixel-perfect styles/copy), wired
to sessionMachine + ArmRouter + ledger. NO "Mock state" chips row (review-only). Components:
top bar (52px sticky, mic glyph accent, Session/Results segmented, live dot only while
session active, mono run provenance only on Results), controls card (Realtime/Cascade
segmented, language-pair button cycling EN↔ES / EN↔YUE, direction-swap icon btn, support pill
gray 'both modes'/amber 'cascade only', autoplay switch only when exactly 1 arm, Stop
session / Start new session), status strip (LIVE four-value mic permission indicator —
not-requested 'mic not requested' muted / requesting 'mic prompt open…' amber / granted 'mic
allowed' green / denied 'mic blocked' red — per PRD §6 NOT the mock's hardcoded label;
connection state; 5-bar meter driven by capture RMS; mono state name; elapsed + autoplay
right), banners (switch-queued, Cantonese target warn, Cantonese input warn, reconnecting,
disconnected red w/ Reconnect, stopped green summary), idle card ('No active session',
'{pair} · {mode} · autoplay on. Your browser will ask for microphone permission.', Start
microphone), permission-denied blocking card (both-layer remediation: site permission AND OS
mic settings; retry affordance with 'browsers do not re-prompt' guidance — design delegated,
use idle-card pattern), arms strip (pills, removable ×, dashed add-arm pill with next arm's
$/min, max 3, autoplay-off note), source card, arm cards grid (status, target text,
indeterminate progress when in flight, red failure notice w/ architecture-differentiated copy,
play/pause full-width with mono duration, per-stage rows label+bar+labelled mono ms normalized
to own total, total + cost + intervals note, realtime opaque-interval footnote), session
footer (utterances, p50, p95, session $, amber 'figures illustrative' pill ONLY when any
displayed figure is illustrative). Exact copy from mock where present.

## Acceptance criteria (RTL, jsdom; fixture transports)
1. Idle default on load: idle card visible, correct subline copy, status strip shows 'no
   connection', meter gray, mic indicator shows the not-requested value (NOT 'mic allowed').
2. Start microphone with fake capture granting → mic indicator flips to granted/green and
   session goes live (listening); with NotAllowedError → permission-denied blocking card
   with BOTH site-layer and OS-layer remediation text, and mic indicator 'denied'.
3. Mode toggle during active session → switch-queued banner "switching to Cascade after this
   sentence finishes"; on utterance boundary the mode applies and banner clears.
4. Adding second arm: autoplay switch disappears (or off), note "autoplay off — two arms would
   talk over each other", arm cards grid 2 columns, source card gains ' — shared by every arm';
   removing back to 1 arm restores autoplay.
5. Arm card ready state renders labelled ms per stage (mono, e.g. '500 ms') — numbers present,
   not bars alone; realtime card shows 3 rows + opaque footnote; cascade card 5 rows.
6. Failed arm: cascade shows stage-named copy, realtime shows opaque copy (exact strings).
7. EN→YUE with realtime active → target-Cantonese warn banner; YUE→EN → input warn instead;
   pill 'cascade only' amber; selection never blocked.
8. Live transcripts: source partials render as they arrive, replaced by final; target deltas
   accumulate (fixture transport script).
