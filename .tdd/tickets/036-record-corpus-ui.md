---
id: 036
title: Wire "Record new clip" — record a take, tag its utterances, save it as corpus
status: pending
source: v3-corpus
depends_on: [035]
touches: [src/client/views/ReplayView.tsx, src/client/components/replay/RecordTake.tsx, src/client/replay/recordingsClient.ts, src/client/browserDeps.ts]
iterations: 0
test_files: []
branch: ""
---

## Why

PRD §7 step 1 requires recording a clip that "is saved and appears in the UI". The button exists
and does nothing (`RECORD_NEW_HINT = 'Microphone capture is not wired into Replay yet'`). This is
the ticket that makes the operator able to record the corpus at all.

## Scope

Wire `[data-record-new]` to a real flow:

1. **Record** a take via ticket 035's `startTake` (24 kHz, cap enforced, live elapsed + level).
2. **Review** — the take is segmented by `segmentTake`; the detected utterances are listed with
   their boundaries. **The operator confirms or adjusts**; segmentation is never silently
   authoritative (a wrong boundary mis-attributes every later category finding).
3. **Tag** each utterance: category (one of the six) and, where a reference exists, the verbatim
   text. Cantonese takes no reference — improvised, no written script (§9).
4. **Save** — POST with `origin: 'corpus'`, ticket 030's manifest, and a `corpusVersion`; the
   Recording appears in the library immediately.

The **ad-hoc path stays**: saving without tagging produces an `origin: 'mic'` Recording with no
manifest, exactly as the library treats mic rows today.

## Acceptance criteria

- [ ] `[data-record-new]` opens the flow; the stale "not wired into Replay yet" hint is GONE
- [ ] A recorded take is POSTed and the new Recording appears in the library without a reload
- [ ] Saved as `origin: 'corpus'` it carries a valid manifest and a `corpusVersion`; the server
      accepts it (ticket 030 validates, so an invalid manifest must be impossible to submit —
      surface the reason in the UI rather than letting the 400 be the first the operator hears)
- [ ] Saved as an ad-hoc clip it is `origin: 'mic'` with **no** manifest key
- [ ] Every utterance must be tagged before a corpus save is allowed; the control states why
- [ ] Reference text is offered for EN/ES and withheld for YUE, with the reason stated
- [ ] Mic denial shows the SAME two-layer remediation the Live view uses (browser site permission
      AND OS privacy setting, plus the no-re-prompt sentence) — do not write a second, weaker copy
- [ ] The 1-minute cap is enforced and visible; a take that hits it stops and says so
- [ ] Cancelling discards the take and POSTs nothing
- [ ] Nothing autoplays; the take may be played back only from an explicit control
- [ ] Styling uses `src/client/styles/tokens.css` variables only; assert via `data-*`, never classes

## Notes

- Decide and document whether a corpus Recording may be re-tagged after runs exist. Recommended:
  allow only at zero runs — retagging afterwards silently rewrites what past samples measured,
  which is the same class of harm as mutable audio (§7: audio is immutable).
- `browserDeps` supplies the real capture seams; `fixtureDeps` must keep working without a mic.
