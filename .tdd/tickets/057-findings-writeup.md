---
id: 057
title: FINDINGS.md — rubric must-have #8, currently 0%
status: pending
source: rubric
depends_on: []
touches: [FINDINGS.md]
iterations: 0
test_files: []
branch: ""
---

## Why

Rubric must-have #8, quoted:

> *"Comparison write-up (1–2 pages) covering latency, quality, cost, controllability, and a
> recommendation for which mode fits which scenario"*

**There is no artifact.** No `FINDINGS.md`, no `COMPARISON.md`, no `results/` directory. It is the
only must-have with zero code or prose behind it, and it is worth more than the rest of the open
backlog combined — the other seven are already built.

## Scope

Draft the skeleton NOW with explicit `not yet measured` placeholders, so the hour real numbers exist
the document is a fill-in rather than a blank page.

**Harvest `HelpView.tsx`.** It already explains the three arms, the experiments and the 5-vs-3
auditability gap in plainer language than the PRD does. It is the write-up's first draft and it is
already written.

## Acceptance criteria

- [ ] Five sections: **latency · quality · cost · controllability · recommendation**
- [ ] Every unmeasured figure is an explicit `not yet measured` placeholder naming **what would fill
      it** — never a blank, never a guess, never a fixture number
- [ ] **Controllability can be written TODAY** — it is reasoned from architecture, not measured:
      the 5-vs-3 observable-interval asymmetry, provider swapping as a contained change, and the
      auditability argument (cascade's transcript IS what got translated and a wrong output can be
      traced to a stage; Realtime's is a second model's guess). For medical and legal interpretation
      that is a compliance question, not a footnote.
- [ ] **Cost's honest state is written today too**: Arm C meters end to end; Arm B's TTS
      (`gpt-4o-mini-tts`) bills audio-out tokens that its API never reports, so Arm B has a per-stage
      split and no total. **That asymmetry is itself a controllability finding** — one provider tells
      you what you spent and the other does not.
- [ ] Limitations stated plainly: N, single evaluator, one operator, whichever language pairs the
      coworker's availability did or did not permit
- [ ] Every number cites the exported bundle it came from; nothing is retyped from a screen
- [ ] 1–2 pages. The PRD is 1,105 lines for a 15–20 hour brief — do not repeat that mistake here.

## Notes
- Recommendation must be **scenario-based** ("which mode fits which scenario"), not a winner.
- If a dimension stays unmeasured at submission, say so in one line and say why. A stated gap is a
  finding; a silent one is a hole.
