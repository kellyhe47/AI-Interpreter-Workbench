---
id: 060
title: The coverage card cites two commit hashes that do not exist — the app displays fabricated evidence
status: pending
source: spec-audit + qa
depends_on: []
touches: [src/client/views/ResultsView.tsx]
iterations: 0
test_files: []
branch: ""
---

## Observed — verified

`src/client/views/ResultsView.tsx:653-654` hardcodes, and the Results screen renders:

```
Spanish → English on cascade · commit a4f21c · +11 lines · one language constant
English → Cantonese on cascade · commit 9d0e77 · +14 lines · one voice id per direction
```

```
$ git cat-file -t a4f21c   → fatal: Not a valid object name a4f21c
$ git cat-file -t 9d0e77   → fatal: Not a valid object name 9d0e77
```

**Neither hash exists in this repository.**

PRD §11 stakes this card on *"onboarding cost is proven by commit, not claimed."* The card is badged
`illustrative`, so it is not presented as a measured experiment — but the specific mechanism the PRD
promised as proof is fabricated. **A wrong number is an error; a wrong citation is a claim that
evidence was gathered when it never was.**

This escalated when the Cantonese track was kept: the coverage card became a real deliverable
answering two of the brief's named Key Impact Metrics — *provider flexibility* and *time-to-onboard
a new language pair*.

## Acceptance criteria

- [ ] Every commit hash the card cites **resolves** — `git cat-file -t` succeeds
- [ ] Every `+N lines` figure comes from the real diffstat of that commit, not a remembered number
- [ ] If a claim has no real commit behind it yet, the tile renders **no digits** and says so —
      it does not carry a plausible placeholder
- [ ] A guard makes an unresolvable hash impossible to ship: the hashes are not free-text prose in
      a component, and something checks them
- [ ] The real EN↔YUE onboarding diff replaces the invented one once that work is done

## Notes
- The honest version of this card is trivially derivable from actual history — the work it describes
  either happened in a commit or it did not.
- Golden eval `eval/golden/10-onboarding-cost-cites-a-real-commit.json`.
