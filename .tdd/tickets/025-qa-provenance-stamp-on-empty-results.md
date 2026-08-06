---
id: 025
title: Provenance stamp asserts a corpus version on an empty Results screen
status: pending
source: qa
depends_on: []
touches: [src/client/App.tsx, src/client/components/TopBar.tsx]
iterations: 0
test_files: []
branch: ""
---

## Repro

1. Open Results with an empty ledger

## Expected

PRD §8 ties provenance to results:

> Every result carries a **provenance line** — corpus version, utterance count, repetitions, pinned
> endpointing value. A number without provenance is a claim; a number with it is citable.

With zero results there is nothing to attribute.

## Observed

The top bar renders `run 2026-08-06 · corpus v1` beside a body reading **"No runs recorded"**. The
results panel itself is correctly digit-free (verified: zero digits), but the stamp sits outside it
and reads as though a run against corpus v1 exists.

Low severity — no figure is fabricated — but it is the same class of misreading that the mandatory
empty state exists to prevent.

## Suggested direction

Suppress the stamp when the ledger has nothing to attribute, or word it as a session/build stamp
rather than a run provenance line.
