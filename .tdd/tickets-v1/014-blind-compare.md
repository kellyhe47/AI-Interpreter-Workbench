---
id: 014
title: Blind compare — randomized persisted draw, 1–5 scoring, reveal
status: green
depends_on: [009, 012]
touches: [src/client/components/BlindCompare.tsx]
test_files: []
iterations: 0
---

## Scope
Comparison-mode-only card per mock: 'compare blind' secondary button (+ 'utterance N · M
arms · all succeeded' note) → card with Sample A/B (identity hidden), play buttons (per-arm
buffered audio), 1–5 score pickers (selected = accent-soft), hint 'arm identity hidden until
you submit', footer 'rate fluency 1–5 · order randomized · scores append to the run ledger';
submit → identities revealed (accent text under titles), hint 'identity revealed — scores
appended to ledger', button label 'submitted'. Order RE-RANDOMIZED on every open (injectable
RNG); the drawn assignment persisted to the ledger WITH the scores (PRD §9 auditable
blinding). Flow ships built-but-unscored: no seeded scores anywhere.

## Acceptance criteria
1. Button only renders when >1 arm active.
2. Open twice with rigged RNG flipping → sample order differs; draw recorded each open.
3. Scores + draw appended to ledger on submit as one entry {utteranceId, order, scores,
   revealedAt}; ledger draw matches the rendered order.
4. Identities hidden pre-submit (arm names absent from DOM), revealed post-submit.
5. Reopening after submit resets scores + hides identities again (fresh draw).
