# Handoff: AI Interpreter Workbench UI (v2)

## Overview
Interactive hi-fi mock of the AI Interpreter Workbench — a browser SPA comparing two live-interpretation architectures (OpenAI Realtime voice-to-voice vs. a composable STT→MT→TTS cascade). Four views: **Live** (real interpretation), **Replay** (reproducible measurement lab), **Results** (experiment screens over one run ledger), **Help** (plain-language guide). Built against the v2 PRD (Replay-flow revision) — the PRD is the functional spec; this mock is the visual/UX spec. Get PRD.md from the project owner; it is the authoritative companion document.

## About the Design Files
These are **design references created in HTML** — prototypes showing intended look and behavior, not production code. Recreate them in the target codebase (PRD §4: Node.js + TypeScript, React SPA). `interpreter-workbench-v2-standalone.html` is self-contained — open in any browser and click through it. `interpreter-workbench-v2.dc.html` is the source (HTML template + a plain React-style logic class at the bottom) — read it for exact styles, copy, and state transitions.

## Fidelity
**High-fidelity.** Colors, type, spacing, radii, and copy are final, per the Interpreter Workbench design system (tokens under `design_system/`). All metric figures are **illustrative** — the real app renders from the run ledger, with mandatory empty states.

## Design system (design_system/tokens/*.css)
- Background #FAFAF9, white cards, ink #18181B, secondary #78716C, hairline borders #E7E5E4.
- Blue `--accent` (oklch 54% 0.19 262) is the ONLY chromatic accent: active tabs, derived-arm pills, corpus pills, live dot, stage bars, progress. Green/red strictly deltas & status; amber warnings/"illustrative".
- Geist; Geist Mono for ms figures, run ids, provenance lines. Headings tracking -0.01em.
- Radius 8px controls, 12px cards, 999px pills. Shadow 0 1px 2px rgba(0,0,0,.05). Lucide-style 1.5px inline SVG icons.

## Core model (PRD §7)
Three entities: **Recording** (input; corpus or mic; immutable audio, editable label, soft delete, corpus undeletable) · **Run** (one Recording × one configuration; armTag derived, origin sweep|manual, status complete|failed) · **LiveSession** (metrics of a real conversation; audio discarded; never compared to Runs).

## Screens

### Top bar
52px sticky. Mic glyph + "Interpreter workbench", segmented Live/Replay/Results/Help, pulsing "live session" indicator on the right while live.

### Live
Max-width 960px column. Purpose line: one architecture, ≤5 min, metrics saved, audio discarded, never evidence.
- **Mock state chips** (idle / permission denied / live / processing / stage failed / reconnecting / disconnected / stopped) — REVIEW-ONLY simulator; real states come from the PRD §7 state machine.
- **Controls card**: Realtime/Cascade segmented toggle · derived-arm pill ("this is Arm A/B/C" accent-soft, "ad-hoc" gray — DERIVED from config, never user-set) · language pair (EN↔ES, EN↔YUE) · direction swap · per-direction support pill · Start/Stop. Second row: Cascade → per-stage model selectors (STT: gpt-4o-transcribe / gpt-4o-mini-transcribe / EL Scribe v2 · MT: gpt-4o-mini / Claude Haiku 4.5 · TTS: gpt-4o-mini-tts / EL Flash v2.5 / EL Multilingual v2), set before session start, voice pinned per vendor; Realtime → context-policy toggle default/trimmed with cost note.
- **Status strip**: mic permission is a FOUR-VALUE property (not-requested muted / requesting / granted green / denied red) — never hardcoded; connection; 5-bar input meter; state (mono); elapsed "2:14 / 5:00 · autoplay on".
- **Banners**: switch-queued (amber, "switching to X after this sentence finishes" — mode/pair/direction all queue at utterance boundary); reconnecting w/ attempt count; disconnected (red, attempts exhausted, history intact, Reconnect); Cantonese-output-on-Realtime warning (warns, never blocks); stopped (green, "LiveSession metrics saved — audio discarded").
- **Permission-denied card** (blocking): browser won't re-prompt after denial; remediation covers BOTH site and OS layers; retry button; Replay/Results stay usable.
- **Idle card**: "Start microphone" + pair/arch/autoplay/5-min summary.
- **Session cards**: source transcript; single target card with arch name + info tooltip, in-flight indeterminate bar, failed state (cascade names the stage, Realtime is opaque — differentiated copy is a PRD finding), labelled per-stage ms rows (5 cascade / 3 realtime w/ opaque model interval + sidecar note), total, $/min ("climbing" default Realtime, "trimmed" flat-ish, cascade flat).

### Replay
Two-column: 330px Recordings library + config/runs column.
- **Library**: rows = label, corpus/mic pill, lang, duration, run count; footer states lifecycle rules (labels editable, audio immutable, soft delete, corpus undeletable). "Record new clip · max 1 min" button.
- **Run configuration panel**: arch toggle + per-stage selectors (cascade), derived-tag pill live ("derived tag: Arm B"/"ad-hoc"), Run + "Batch sweep…" buttons, pinned-constants note (Replay context = zero, 1× pacing, manual never aggregated).
- **Batch progress** (mock, toggled by Batch sweep): "run 17 of 45 · rec × arm · rep 3/5", elapsed/remaining, progress bar, counterbalance/warmup/retry-once notes, "Cancel — keep completed runs".
- **Runs list** per selected Recording: cards with armTag pill (accent for named, gray ad-hoc), config string, origin/rep/snapshot meta (mono), complete/failed pill, play-on-demand, labelled per-stage ms inline, total + $/min. Failed run card shows stage-named red notice, saved + excluded from aggregates.
- **Blind compare** (2 runs of one Recording): playback-only (transcripts hidden pre-submit — catches wrong-language pronunciation), adequacy + fluency 1–5 each, random draw persisted to ledger, reveal after submit.

### Results
Header + "show recorded runs (mock)" switch; **empty state is default in the real app** ("No runs recorded" / Run sweep). Two tabs:
- **Experiments**: 4 question-titled cards, each with track eyebrow, amber "illustrative" pill, mono provenance line reporting ACTUAL N ("4 of 5 reps completed"), metric grid, gray takeaway.
  1. Exp 1 (A vs B, vendor constant): p50/p95/cost/WER(sidecar)/adequacy/fluency/observable intervals.
  2. Exp 2 (B vs C, ONLY TTS differs): p50/p95/cost/WER "— (STT unchanged)"/fluency.
  3. Conversation-length: sourced from LiveSessions, 3 columns — realtime-default / realtime-trimmed / cascade; takeaway attributes the slope to token billing.
  4. Coverage: per-DIRECTION rows (EN→YUE ≠ YUE→EN), per-stage cells (runs/ok green, not-listed red, verify amber), Mandarin-pronunciation observation note, 3 time-to-add tiles w/ commit hashes.
- **By Recording & category**: category table (numbers & dates +400 ms finding) + per-recording table incl. ad-hoc/manual rows and a failed row.

### Help
Six cards, plain language: research question (sealed box vs assembly line), Live vs Replay + three-entity explainer, the arms (derived tags), the experiments (non-pooling), how to use, how to read (p50/p95, cost slope, provenance, illustrative badges).

## Interactions & state (all in the logic class)
view, arch, sttIdx/mtIdx/ttsIdx, ctx, langIdx/reversed, liveState, pending (switch queue), selRec, batchOpen, blind state, hasRuns, resultsTab. Key rules: armTag DERIVED (B = 4o-transcribe/4o-mini/4o-mini-tts exactly; C = same but EL Flash TTS; anything else ad-hoc); switches queue ~2.6 s when live (simulated boundary), instant otherwise; experiments aggregate only armTag-matched + origin:sweep + status:complete.

## Files
- interpreter-workbench-v2-standalone.html — self-contained interactive mock
- interpreter-workbench-v2.dc.html — source (styles/copy/state)
- design_system/ — token CSS
