# Handoff: AI Interpreter Workbench UI

## Overview
Interactive hi-fi mock of the AI Interpreter Workbench — a browser SPA comparing two live-interpretation architectures (OpenAI Realtime voice-to-voice vs. a composable STT→MT→TTS cascade). Two views: **Session** (live interpretation cockpit) and **Results** (four experiment screens over one run ledger). Built to accompany `PRD.md` (included) — the PRD is the functional spec; this mock is the visual/UX spec.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, not production code to copy. Recreate them in the target codebase's environment. Per the PRD (§4), the target stack is **Node.js + TypeScript, React SPA**. `interpreter-workbench-standalone.html` is a self-contained snapshot that opens in any browser — use it as the interactive reference. `interpreter-workbench.dc.html` is the source (an HTML template + a plain React-style logic class near the bottom of the file) — read it for exact styles, copy, and state transitions.

## Fidelity
**High-fidelity.** Colors, type, spacing, radii, and copy are final and follow the Interpreter Workbench design system (tokens included under `design_system/`). Recreate pixel-perfectly using these tokens. All metric figures shown are **illustrative** — the real app must render them from the run ledger, with mandatory empty states (PRD §7).

## Design system (tokens in design_system/tokens/*.css)
- Background `--surface-app` #FAFAF9, cards white, ink text #18181B, secondary #78716C, borders #E7E5E4.
- Blue `--accent` oklch(54% 0.19 262) is the ONLY chromatic accent (active toggles, live dot, links, stage bars). Green/red strictly for deltas & status; amber for warnings/"illustrative" badges.
- Type: Geist; Geist Mono for ms figures, run ids, timestamps, provenance lines. Headings tracking -0.01em.
- Radius: 8px buttons/inputs, 12px cards, 999px pills. Card shadow 0 1px 2px rgba(0,0,0,.05). Hairline 1px borders do separation.
- Icons: Lucide-style outline, 1.5px stroke, 14–16px, inline SVG.

## Screens

### 1. Top bar (both views)
52px sticky bar, white, hairline bottom border. Left: mic glyph (accent) + "Interpreter workbench" (600 14px). Session/Results segmented control (selected = `--surface-selected` fill, ink text). Right: pulsing live dot + "live" when session active, mono provenance "run 2026-08-05 · corpus v1".

### 2. Session view (default)
Max-width 1060px column, 16px gaps:
- **Mock state chips** (live / processing / reconnecting / stopped) — REVIEW-ONLY simulator, do not build; real states come from the session state machine (PRD §6, which also defines idle, requesting-permission, permission-denied, listening, ready, playing, switch-queued, disconnected, stopping/stopped — all must exist in the real app).
- **Controls card** (always visible per PRD): Realtime/Cascade segmented toggle · language-pair button (EN↔ES, EN↔YUE) · direction-swap icon button · support pill ("both modes" gray / "cascade only" amber) · autoplay switch (only when exactly one arm) · Stop session / Start new session.
- **Status strip**: mic allowed (green), connected (green; "reconnecting…" amber), 5-bar input level meter (accent bars), state name (mono), elapsed + autoplay state (mono, right).
- **Banners** (amber unless noted): reconnecting attempt count; Cantonese-on-Realtime warning (non-blocking, PRD §6); stopped summary (green: "Session stopped · 5:02 · 32 utterances · 0 dropped · $0.71").
- **Arms strip**: pill per active arm (Realtime = accent-soft, cascades = gray fill), removable (×) when >1; dashed "add arm" pill showing next arm's $/min BEFORE enabling (PRD §6). Max 3 arms. Adding a 2nd arm forces autoplay off + note "autoplay off — two arms would talk over each other".
- **Source card**: "Source · English — shared by every arm" + utterance text + utterance #.
- **Arm cards** grid (1 col single-arm, N cols comparison). Each card: name + status (in flight/ready/playing), target text, full-width play/pause button with audio duration, per-stage latency rows — label + proportional bar + **labelled ms in mono** (PRD §7: numbers required, bars alone don't satisfy). Realtime: endpointing 500/model 471/queue 9 ms, "3 intervals · 1 opaque", footer note about opaque model + sidecar transcript. Cascade B: endpointing/stt/mt/tts/queue = 500/42/298/201/12, "5 intervals · all visible". Cascade C (best-of-breed): 500/31/298/74/11. Footer: total (bold mono) + $/min. Processing state: indeterminate accent progress bar. Failed state: red inline notice naming the failed stage; session survives.
- **Blind compare** (comparison mode only): "compare blind" button reveals card with Sample A/B (randomized order), play buttons, 1–5 score pickers (selected = accent-soft), submit → identities revealed, scores append to ledger.
- **Session footer**: utterance count, p50, p95, session $, "figures illustrative" amber pill.

### 3. Results view
Header "Results" + "show recorded runs" switch (mock; real app derives from ledger).
- **Empty state** (no runs): centered chart glyph, "No runs recorded", "Run sweep" button. Mandatory before real data exists.
- **Four question-titled cards**, each with: track eyebrow (uppercase 10.5px), amber "illustrative" pill, 17px title, mono provenance line, metric grid (secondary label / mono values / right-aligned colored delta), gray takeaway note.
  1. "Does the architecture itself cost latency?" — Exp 1 table (p50, p95, cost/min, WER w/ sidecar tag, adequacy, fluency, observable intervals).
  2. "What does swapping providers buy?" — Exp 2 table.
  3. "What changes as the conversation continues?" — stability table (completion, disconnects, p50 min1/min5, drift, cost slope, heap, context loss; red/green cell coloring).
  4. "What does provider choice actually let us reach?" — coverage matrix by stage (runs/ok green, not listed red, verify amber, — gray), observation note block (Mandarin-pronunciation finding), three time-to-add tiles with commit-hash provenance sublines (6 min / 1h 48m / n-a).
- **Run ledger card**: table of run id (mono), experiment, configuration, pair, N, date.

## Interactions & state
State variables: view, mode (realtime|cascade), langIdx, reversed, autoplay, arms[], sessionState, playingArm, blindOpen/blindRevealed/blindScores, hasRuns. Key rules (all from PRD §6): mic captured once, fanned out to all arms; autoplay allowed only with exactly one arm; nothing autoplays in comparison mode; mode/language switches queue at utterance boundary; unsupported pair warns but never blocks; transcript history survives switches and reconnects. Motion: 150ms ease-out color/opacity only; live dot + waveform pulse allowed.

## Assets
No image assets. All icons are inline SVG (Lucide-style outline). Fonts: Geist + Geist Mono via Google Fonts (see design_system/tokens/fonts.css).

## Files
- `interpreter-workbench-standalone.html` — self-contained interactive mock (open in browser)
- `interpreter-workbench.dc.html` — source: template + logic class (exact styles/copy/state)
- `PRD.md` — full product requirements (the functional contract)
- `wireframes.html` — earlier lo-fi wireframes for provenance
- `design_system/` — token CSS files (colors, typography, spacing, effects, fonts)
