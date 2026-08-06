---
id: 036
title: Wire "Record new clip" — record a take, tag its utterances, save it as corpus
status: green
source: v3-corpus
depends_on: [035]
touches: [src/client/views/ReplayView.tsx, src/client/components/replay/RecordTake.tsx, src/client/replay/recordingsClient.ts, src/client/browserDeps.ts]
iterations: 0
test_files: [src/client/views/ReplayView.record.test.tsx]
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

## Attempt log

- Green in one implementation pass. 33 tests in the locked file; suite 1178/66; both typechecks and
  `npm run build` clean.
- Test-writer ran the reference-implementation check before handing over (write a throwaway impl,
  confirm the tests CAN go green, revert, re-confirm red). It paid: it proved the LiveView copy
  extraction breaks no Live test, that the `validateManifest` assertion works without coupling to
  minted ids, and that a ticking elapsed timer would destabilise RTL waits — which the implementer
  then avoided by driving elapsed off the capture seam's own `onLevel` rather than a `setInterval`.
- **Mic-denial copy is now shared, not duplicated.** `src/client/copy/micDenial.ts` holds the four
  constants; LiveView and RecordTake both import them. Live's tests pin loosely and stayed green
  untouched. A source-grep confirms neither view restates the copy.
- Utterance `index` is DERIVED from array position, so removal renumbers 1..N by construction —
  the UI cannot emit a non-contiguous manifest at all.
- Blocked reasons cascade: missing category -> missing EN/ES reference -> `validateManifest`'s own
  reason, surfaced in the UI so the server's 400 is never the first the operator hears.
- Decision recorded in the component header: **no re-tagging.** Tagging happens once, before the
  Recording exists, and the flow closes on save — retagging later would rewrite what past samples
  measured, the same class of harm as mutable audio (PRD §7).

### Verified in the running app, not only in tests

- `[data-record-new]` is enabled, opens the panel at stage `armed`, and states
  *"Maximum 1 minute — the take stops itself at the cap."*
- Pressing Start with the mic blocked lands on stage `denied` showing the SHARED Live copy: browser
  site permission, OS microphone setting, and *"Browsers do not re-prompt after a denial"*.
- End-to-end through the real modules and the real server: a synthetic 45 s take with four bursts
  ran through the REAL `segmentTake`, which recovered all four boundaries exactly
  (1.00-5.50, 9.00-20.00, 24.50-33.00, 37.00-43.50 s); the manifest passed the REAL
  `validateManifest`; `POST /api/recordings` returned 201 with 4 utterances and `corpus-v1`.
- The saved Recording appears in the library (`corpus · en · 0:45 · 0 runs`) and is runnable under
  BOTH architectures — Cascade derives Arm B, Realtime derives Arm A, Run and Batch enabled in both.

### Not verified here, and why

**A real microphone take.** This QA browser has no grantable mic — that is exactly why fixture mode
exists. The capture seam is covered by ticket 035's unit tests and the denial path is verified live,
but the operator must confirm one real take end to end.

`fixtureDeps` deliberately does NOT get a synthetic `startTake`: fabricating audio into the real
recordings store would contradict that file's standing rule that fixture mode is not a second
production build. Fixture mode shows the shared denial card instead.
