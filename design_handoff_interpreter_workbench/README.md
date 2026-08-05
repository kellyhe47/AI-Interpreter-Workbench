# Handoff: AI Interpreter Workbench UI

## Overview
Interactive hi-fi mock of the AI Interpreter Workbench — a browser SPA comparing two live-interpretation architectures (OpenAI Realtime voice-to-voice vs. a composable STT→MT→TTS cascade). Two views: **Session** (live interpretation cockpit) and **Results** (four question-titled screens over one run ledger). Built to accompany `PRD.md` — the PRD is the functional spec; this mock is the visual/UX spec.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, not production code to copy. Recreate them in the target codebase's environment. Per the PRD (§4), the target stack is **Node.js + TypeScript, React SPA**. `interpreter-workbench-standalone.html` is a self-contained snapshot that opens in any browser — use it as the interactive reference. `interpreter-workbench.dc.html` is the source (an HTML template + a plain React-style logic class near the bottom of the file) — read it for exact styles, copy, and state transitions.

## Fidelity
**High-fidelity.** Colors, type, spacing, radii, and copy are final and follow the Interpreter Workbench design system (tokens included under `design_system/`). Recreate pixel-perfectly using these tokens. All metric figures shown are **illustrative** — the real app must render them from the run ledger, with mandatory empty states (PRD §7). The Results view lands on its empty state by default (`hasRuns: false`) — that is deliberate, not an oversight.

## Design system (tokens in design_system/tokens/*.css)
- Background `--surface-app` #FAFAF9, cards white, ink text #18181B, secondary #78716C, borders #E7E5E4.
- Blue `--accent` oklch(54% 0.19 262) is the ONLY chromatic accent (active toggles, live dot, links, stage bars). Green/red strictly for deltas & status; amber for warnings/"illustrative" badges.
- Type: Geist; Geist Mono for ms figures, run ids, timestamps, provenance lines. Headings tracking -0.01em.
- Radius: 8px buttons/inputs, 12px cards, 999px pills. Card shadow 0 1px 2px rgba(0,0,0,.05). Hairline 1px borders do separation.
- Icons: Lucide-style outline, 1.5px stroke, 14–16px, inline SVG.

## Screens

### 1. Top bar (both views)
52px sticky bar, white, hairline bottom border. Left: mic glyph (accent) + "Interpreter workbench" (600 14px). Session/Results segmented control (selected = `--surface-selected` fill, ink text). Right: pulsing live dot + "live" **only while a session is active**; mono run provenance "run 2026-08-05 · corpus v1" **only on Results** — a live session is not a run, and showing run provenance over it is a category error.

### 2. Session view (default)
Max-width 1060px column, 16px gaps.

**Mock state chips** — REVIEW-ONLY simulator, do not build. Seven states: `idle · live · processing · stage failed · reconnecting · disconnected · stopped`. Real states come from the session state machine (PRD §6), which also defines `requesting-permission`, `permission-denied`, `listening`, `ready`, `playing`, `switch-queued`, and `stopping` — all must exist in the real app. See **Known gaps** below for the two that are not yet designed.

- **Controls card** (always visible per PRD): Realtime/Cascade segmented toggle · language-pair button (EN↔ES, EN↔YUE) · direction-swap icon button · support pill ("both modes" gray / "cascade only" amber) · autoplay switch (only when exactly one arm) · Stop session / Start new session.
- **Status strip**: mic state, connection state ("connected" green / "reconnecting…" amber / "no connection" muted when idle, stopped, or disconnected), 5-bar input level meter (accent bars while live, gray otherwise), state name (mono), elapsed + autoplay state (mono, right).
- **Idle screen** (default on load): centered card — mic glyph, "No active session", subline "{pair} · {mode} · autoplay on. Your browser will ask for microphone permission.", primary **Start microphone** button. This is the first screen a user ever sees.
- **Banners** (amber unless noted):
  - **switch queued** — "switching to {target} after this sentence finishes". Fires on mode, language-pair, and direction changes; mock resolves after 2600 ms to stand in for the utterance boundary. Instant apply when no session is active.
  - **Cantonese-on-Realtime** — non-blocking; gated on **target** language only. EN→YUE warns; YUE→EN does not, because that direction depends on Realtime *recognising* Cantonese, a different claim (PRD §6). The pair-level pill is labelled by the more constrained direction, so the pill and the banner can legitimately disagree.
  - **reconnecting** — attempt count, transcript preserved.
  - **stopped summary** (green): "Session stopped · 5:02 · 32 utterances · 0 dropped · $0.71".
- **Arms strip**: pill per active arm (Realtime = accent-soft, cascades = gray fill), removable (×) when >1; dashed "add arm" pill showing the next arm's $/min BEFORE enabling (PRD §6). Max 3 arms. Adding a 2nd arm forces autoplay off and shows "autoplay off — two arms would talk over each other". **Removing back down to one arm restores autoplay**, so the live-interpreter default is always recoverable.
- **Source card**: "Source · {LANG}" + " — shared by every arm" suffix only in comparison mode, utterance text, utterance #.
- **Arm cards** grid (1 col single-arm, N cols comparison). Each card: name + status (in flight / ready / playing / failed), target text, full-width play/pause button with audio duration, per-stage latency rows — label + proportional bar + **labelled ms in mono** (PRD §7: numbers required, bars alone don't satisfy). Bar widths normalize to **that arm's own total**, not a shared constant.
  - Realtime: endpointing 500 / model 471 / queue 9 ms · total 980 ms · $0.140/min · "3 intervals · 1 opaque" · footer note on the opaque model interval and the sidecar transcript.
  - Cascade · OpenAI: 500 / 42 / 298 / 201 / 12 ms · total 1053 ms · $0.021/min · "5 intervals · all visible".
  - Cascade · best-of-breed: 500 / 31 / 298 / 74 / 11 ms · total 914 ms · $0.055/min.
  - **Processing**: indeterminate accent progress bar.
  - **Failed**: red inline notice; **the copy differs by architecture and that is deliberate** — cascade names the stage ("mt stage timed out for this utterance · session still running"), Realtime cannot ("opaque failure — no stage attribution · session still running"). Session survives either way. This extends the auditability finding into the error path (PRD §11).
- **Blind compare** (comparison mode only): button reveals a card with Sample A/B, play buttons, 1–5 score pickers (selected = accent-soft), submit → identities revealed. **Order is re-randomized on every open** and the drawn assignment must be persisted to the run ledger with the score — a fixed A↔B swap stops being blind after one reveal (PRD §9).
- **Session footer**: utterance count, p50, p95, session $, "figures illustrative" amber pill.

### 3. Results view
Header "Results" + "show recorded runs" switch (mock only; the real app derives this from the ledger).
- **Empty state** (default): centered chart glyph, "No runs recorded", "Run sweep" button. Mandatory before real data exists.
- **Four question-titled cards**, each with: track eyebrow (uppercase 10.5px), amber "illustrative" pill, 17px title, mono provenance line, metric grid (secondary label / mono values / right-aligned colored delta), gray takeaway note.
  1. **Track 1 of 3 · vendor held constant** — "Does the architecture itself cost latency?" (p50, p95, cost/min, WER w/ sidecar tag, adequacy, fluency, observable intervals).
  2. **Track 2 of 3 · architecture held constant** — "What does swapping providers buy?" Provenance states "not pooled with track 1".
  3. **Track 1 · extended along time** — "What changes as the conversation continues?" (completion, disconnects, p50 min1/min5, drift, cost slope, heap, context loss; red/green cell coloring). Takeaway carries the `gpt-realtime-translate` correction — the slope belongs to token billing, not to voice-to-voice.
  4. **Track 3 of 3 · exploratory case study** — "What does provider choice actually let us reach?" Coverage matrix by stage (runs/ok green, not listed red, verify amber, — gray), observation note block (Mandarin-pronunciation finding), three time-to-add tiles with commit-hash provenance sublines.
- **Run ledger card**: table of run id (mono), experiment, configuration, pair, N, date. All four cards read from this; it is the source of truth.

## Interactions & state
State variables: `view, mode, langIdx, reversed, autoplay, arms[], sessionState, pending, playingArm, blindOpen, blindRevealed, blindScores, blindOrder, hasRuns`.

Key rules (all from PRD §6): mic captured once and fanned out to all arms; autoplay allowed only with exactly one arm and restored when returning to one; nothing autoplays in comparison mode; mode, language, and direction changes queue at the utterance boundary via `pending`; unsupported target language warns but never blocks; transcript history survives switches and reconnects. Motion: 150 ms ease-out color/opacity only; live dot + waveform pulse allowed.

## Deliberately undesigned — implementer's discretion

**Microphone permission states.** The mock renders "mic allowed" as a fixed label (`interpreter-workbench.dc.html:94`) and has no denied state. This is **not an oversight to be matched — it is delegated.** Permission is a four-value property (`not-requested · requesting · granted · denied`) and its presentation is left to implementation.

Build to **PRD §6 "Microphone permission — a four-value property"**, not to this mock. The constraints that determine correctness are functional, not visual: the indicator must reflect the live value rather than a default, `denied` blocks session start and so cannot be dismissible, browsers do not re-prompt after a denial (a bare retry silently fails), and permission can be blocked independently at the site and OS layers.

Use the design system tokens and the existing status-strip and idle-card patterns as the reference for how it should *look*; the PRD determines how it must *behave*.

## Assets
No image assets. All icons are inline SVG (Lucide-style outline). Fonts: Geist + Geist Mono via Google Fonts (see `design_system/tokens/fonts.css`).

## Files
- `interpreter-workbench-standalone.html` — self-contained interactive mock (open in browser)
- `interpreter-workbench.dc.html` — source: template + logic class (exact styles/copy/state)
- `design_system/` — token CSS files (colors, typography, spacing, effects, fonts)

Referenced but held outside this bundle, in the repo root: `PRD.md` (the functional contract) and `please_ignore/wireframes.html` (earlier lo-fi wireframes, for provenance only).
