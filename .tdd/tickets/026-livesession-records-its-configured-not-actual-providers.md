---
id: 026
title: A LiveSession records the CONFIGURED provider triple, not the one that actually served it
status: pending
source: qa-followup
depends_on: [018]
touches: [src/client/views/useSessionController.ts, src/client/state/ledger.ts, src/client/components/results/derive.ts]
iterations: 0
test_files: []
branch: ""
---

## How this surfaced

Found by ticket 018's implementer while making fixture-sourced LiveSessions fail the realness
predicate. `isRealLiveSession` alone could not make the F1 repro pass, and the reason is a defect
one layer down.

## The defect

`useSessionController.saveLiveSession` stamps `providerTriple` and `modelSnapshots` from the
**selected `LiveRunConfig`** — what the user picked in the controls — not from the transport that
actually served the utterances.

Under `?fixture=1` a scripted `FixtureTransport` serves every utterance, but the saved `LiveSession`
claims `{ realtime: 'gpt-realtime' }` (or Arm B's real triple). **The record asserts a provenance it
does not have.** Its own utterance records tell the truth — they carry
`providers: {stt:'fixture', mt:'fixture', tts:'fixture'}` and `arm: 'fixture'` — but the session
header contradicts them.

Why it matters beyond fixture mode: the same code path would mis-stamp any session where the
configured triple and the serving transport diverge. A record that lies about which models produced
it is precisely what `deriveArmTag`'s derive-never-declare rule exists to prevent, applied one level
up — and a LiveSession is the unit PRD §8's conversation-length card is sourced from.

## Current mitigation (ticket 018, shipped)

`derive.ts` carries a local, unexported `isMeasuredLiveSession`: a session is also excluded when any
`UtteranceRecord` under `runId === session.id` fails `isRealRecord`. A session with **no** records is
judged on the predicate alone, which is what keeps `seedLiveSessions` and the `sessionTestKit`
sessions (deliberately "real-looking") unaffected.

That is a correct guard at the reporting layer, and it is why the Results view is now honest. It
does not fix the stored record.

## Acceptance criteria

- [ ] A `LiveSession` saved from a session served by a fixture transport records fixture-named
      providers/snapshots — the header agrees with its own utterance records
- [ ] A `LiveSession` saved from a real transport is unchanged (regression)
- [ ] `isRealLiveSession` alone then suffices for the F1 case; `derive.ts`'s records-linked
      `isMeasuredLiveSession` becomes belt-and-braces rather than load-bearing. **Keep both** — two
      independent gates on "no fixture number is ever reported" is the right amount for this rule
- [ ] The utterance records under a session and the session header can never disagree about whether
      the run was fixture-sourced — assert that invariant directly

## Suggested direction

The transport knows what it is. `InterpreterTransport` implementations already carry identity
(`FixtureTransport.providers` defaults to `FIXTURE_PROVIDERS`, added in ticket 008). Have the
controller stamp the session from the **active transport's** reported providers rather than from the
selected config, falling back to the config only when the transport reports none.

## Not urgent

The reporting layer is already honest (018), so no wrong number reaches a screen today. This closes
the gap at the source, before a stored LiveSession with a false header ever reaches the server store
or an export bundle.
