---
id: 049
title: A throwing AudioContext constructor still kills Live from inside the transport callback, and Replay leaks one context per press
status: pending
source: code-review (047 round 3)
depends_on: [047]
touches: [src/client/audio/playback.ts, src/client/browserDeps.ts, src/client/views/useSessionController.ts]
iterations: 0
test_files: []
branch: ""
---

## Why

Ticket 047 R3-1 fixed ONE path where `new AudioContext()` throwing wedged Live: the Start-gesture
resume now runs inside a `try/catch`, after `requestCapture()`. Two related problems remain, both
found while writing that test and both deliberately scoped out.

### 1. The lazy construction inside `ArmPlayback.enqueue` is unguarded
`ArmPlayback` builds its context lazily, so with a hostile `AudioContext` the FIRST TTS chunk throws
from inside the transport's `onAudio` callback rather than from the click handler. This is
**pre-existing** — true before 047 R2-3 added the Start-path resume — which is exactly why it did
not belong in 047. The test-writer's first draft of the R3-1 test drove real audio and stayed red
even with the agreed fix applied; narrowing that test to an audio-free cascade script was the right
call, and it carries an in-file note so nobody reads it as full coverage of a hostile `AudioContext`.
With 047 landed, Live starts and runs — and then the first chunk throws into a transport callback,
where nothing catches it and nothing is surfaced.

### 2. `playRun` / `playTake` leak one AudioContext per press
`browserDeps.ts` constructs a NEW `AudioContext` on every Replay play press and never `close()`es
it. This is what makes problem 1 (and 047's R3-1) reachable in practice rather than theoretically:
Chrome caps contexts per document (~6), so a QA pass playing a dozen Replay runs exhausts the cap,
and the next `new AudioContext()` anywhere in the app throws. The reviewer named this sequence
explicitly — play >= 6 Replay runs, then go to Live and press Start.

## Scope

Make a failing `AudioContext` a degraded experience, never a dead one — and stop manufacturing the
condition.

## Acceptance criteria

- [ ] A hostile `AudioContext` (constructor throws) does not kill a Live session at ANY point: not
      at Start (047 R3-1, already green — keep it), and not on the first or any later audio chunk
- [ ] When playback cannot be constructed, the operator is TOLD — a surfaced, non-fatal state, not a
      silent swallow. Live continues: the session still runs, transcripts still arrive, timings are
      still measured. Only the sound is missing.
- [ ] Realtime Live is unaffected either way: it never uses `ArmPlayback`, and its audio rides the
      `remoteAudioSink` element
- [ ] `playRun` / `playTake` release their `AudioContext` — one per press must not accumulate.
      Prefer ONE reused context over closing each; state which you chose.
- [ ] Playing >= 10 Replay runs, then starting a Live session, works — the sequence that motivated
      this ticket
- [ ] **Measurement is untouched.** A missing playback context must not change a timing, fail a run,
      or alter `status` — sound is not a measurement. Pin it.

## Notes

- 047's `useSessionController.ts` Start-path `try/catch` is the shape to follow.
- jsdom has no `AudioContext`; everything stays an injectable seam
  (`playbackContextFactory` already is).
- Do NOT make this a reason to reintroduce a play/pause control in Live — ticket 047 removed it
  deliberately and its source guards forbid it.

## Also folded in — a comment nit from 047's final review

`browserDeps.ts:144` reads: *"It keeps its play()/pause() methods because Replay's muted sink is this
same object; nothing in Live calls either one."*

The load-bearing half is exactly right. The stated REASON is not: the reviewer grepped every
non-test caller of the sink and found the only one anywhere in the client is
`realtime.ts:434 this.deps.remoteAudioSink?.attach(stream)`. **Replay does not call `play()` or
`pause()` either** — the sole callers are `browserDeps.inboundTap.test.ts` (ticket 046's lock,
asserting they do not throw). The methods survive because they sit on the shared `RemoteAudioSink`
interface and ticket 047 explicitly permitted them on the seam, not because Replay drives them.

One clause: *"because the seam is shared with Replay's muted sink"*.

---

## ROUND 2 — code review findings (independent reviewer, against `aa1e7c9`)

16 of 18 mutations caught, including every one the test-writer claimed. Measurement really is
untouched — `queuedAt`/`totalSamples` are stamped before `getContext()`, and ledger records, the
duration readout and the footer are byte-identical between a healthy and a hostile run, pinned by a
real cross-run equality test rather than a re-assertion of literals. Two mutations slipped and two
operator-visible falsehoods were found.

### R2-1 (MAJOR) — the notice stays up over an AUDIBLE realtime session after a mid-session mode switch
`LiveView.tsx:1085`. The notice is gated only on `controller.playbackUnavailable` (latched for the
App's lifetime) and `showSessionArea`. But Live's Realtime/Cascade buttons are never disabled and
`requestMode` swaps the transport mid-session.
**Reproduced against the real `App`:** start Cascade with a hostile factory -> chunk drops -> notice
appears -> click **Realtime** -> transport swaps, audio now rides `remoteAudioSink` and is audible
-> **the notice is still on screen.**
This is precisely the "realtime shows the notice while audible" case the report-from-`enqueue`-only
rule exists to prevent. That rule protects the START path and nothing else — the mode switch walks
straight around it.
**DECIDED:** gate the notice on `state.mode === 'cascade'` as well.

### R2-2 (MAJOR) — the notice survives Stop and then states a falsehood
Same site. `showSessionArea = !idleLike && !denied`, so `status === 'stopped'` still renders the
session area. Confirmed by probe: after **Stop session** the notice remains, reading *"The session
is still running and still being measured"* — it is not running.
**DECIDED:** gate on the live/stoppable statuses too, so it cannot outlive the session it describes.

### R2-3 (MAJOR, test gap) — the `onPlaybackUnavailable` wiring is UNOBSERVABLE
`useSessionController.ts:329`. **Mutation M11 SLIPPED: deleting the wiring entirely leaves all 1839
tests green.** `onAudio` already calls `bump()` immediately after `store.playback.enqueue(e.pcm)`,
so the re-render happens regardless — the AC "the operator is TOLD" is currently satisfied
INCIDENTALLY. A future refactor that moves or conditions that `bump()` kills the notice silently,
and nothing pins the seam the stub commit introduced.
**DECIDED:** pin the callback itself — drive `ArmPlayback` through a path with no other re-render
source, or assert the controller callback fires.

### R2-4 (MINOR) — a dead branch that advertises the one thing this ticket forbids
`playback.ts:231`: `this.buffered = []` inside `play()`'s `ctx === null` branch. Unreachable
(`buffered` is only pushed when `enqueue` obtained a context, and once obtained `getContext()` never
returns null). **Mutation M13 SLIPPED** — deleting it leaves the suite green. Harmless today, but it
reads as "drop queued audio without reporting", which is exactly what R2-2's rule prohibits.
**DECIDED:** delete it.

### R2-5 (MINOR) — Replay degrades COMPLETELY silently
`browserDeps.ts:369/394` wire no `onPlaybackUnavailable`. If the bag's single `AudioContext` throws,
`playRun` and `playTake` become no-ops with zero feedback anywhere — previously `playTake` at least
threw out of the click handler. No AC covers it.
**DECIDED:** fold it in. A press that produces no sound and no message is indistinguishable from a
run with no audio, which is a real diagnosis the operator makes in Replay.

### R2-6 (MINOR) — the latch is PAGE-lifetime, and a transient failure is unrecoverable
The reviewer confirmed the store is built once at shell level (`App.tsx:144`), NOT per-LiveView
mount — so the mount-leak concern is unfounded. But `contextFailed` can then never clear without a
page reload, and `newSession` cannot recover. For the context-cap case never-retry is right. For a
TRANSIENT failure — Safari policy state at the Start gesture, or a cap that frees when a capture or
tap context closes — Live is permanently mute until reload.
**DECIDED:** clear `contextFailed`/`reported` from `newSession`, NOT from `reset()`. One throw per
session is a negligible price for recovering a transient failure; `reset()` must still not clear it,
or the notice flickers per utterance (pinned by mutation M10).

### R2-7 (accepted, no change) — the realtime guard tests an assumption, not the mechanism
`realtime.ts:596` DOES call `h.onAudio?.()` on `response.output_audio.delta`, and the controller's
`onAudio` is mode-agnostic; the REALTIME GUARD test strips the audio event with `dropAudio: true`,
so it only proves "no enqueue -> no notice". The load-bearing claim — that WebRTC never delivers
that event — is ticket 040's empirical finding recorded as a code comment, not something a fixture
can prove. Accepted as-is; it is on the operator smoke list.

## STILL UNPROVEN — operator's real-Chrome check
- Replay's single reused context, once suspended by autoplay policy, actually RESUMES on the 2nd-10th press
- The whole page stays under Chrome's cap across a long QA pass, once capture contexts and the realtime in/outbound taps are counted with their async closes
- `response.output_audio.delta` truly never arrives on the WebRTC data channel (040's finding)

---

## ROUND 3 — re-review of round 2 (independent reviewer)

28 mutations run, **25 caught**. Both round-1 slips are closed: deleting the controller wiring (M11)
is now caught by the reason row plus the tripwire, and restoring `play()`'s dead
`this.buffered = []` (M13) is caught by the structural guard.

**The gate was verified correct in BOTH directions — including the false-negative risk.**
`STOPPABLE_STATUSES` is a strict SUPERSET of `TRANSPORT_STATUSES`, which is the only set during
which a transport exists to deliver `onAudio`; and `stopSession` calls `store.router.stop()`
synchronously before the status can be observed as `stopping`, so no chunk can be enqueued outside
the gate. The queued-switch path was checked too — `state.mode` is always the APPLIED mode, so
neither a pending cascade->realtime nor realtime->cascade switch raises or suppresses the notice
early. **There is no status in which cascade audio is enqueued but the notice is suppressed.**

### R3-1 (MAJOR) — R2-5 is HALF-DELIVERED: `playTake` never reaches the funnel
`ReplayView.tsx:612` passes `playTake={deps.playTake}` RAW, bypassing the `playRun` funnel, and the
consumer narrows the type straight back down: `RecordTake.tsx:110` declares
`playTake?: (take: RecordedTake) => void` — ONE argument — and `:598` calls `playTake?.(take)`.
So the `onUnavailable` parameter added to `buildReplayDeps().playTake` has **zero production
callers**; it is exercised only by the test calling the seam directly.
Operator scenario: open the record flow, press **Play take** with the context cap full -> silent
no-op, no notice, no console. Exactly the state R2-5 was opened to remove — and worse than the run
case, because a freshly recorded take has no "no audio stored" explanation available at all.
An unused parameter that READS as wired is a landmine: the next author will assume Replay reports.
**DECIDED:** widen `RecordTakeProps.playTake` to the two-arg signature and route it through the same
funnel. Do not take the alternative (dropping the parameter and reporting only for runs) — the take
press is the more ambiguous of the two.

### R3-2 (MINOR, demonstrated consequence) — `clearPlaybackFailure()` clearing `reported` is RIGHT but unpinned
Mutation R2i SLIPPED: deleting `this.reported = false` (`playback.ts:174`) leaves all 1853 green.
The reviewer probed the consequence against the real `App` — two sessions, two DIFFERENT failures:
- as implemented: session 2 shows `InvalidStateError: audio hardware is unavailable`. Correct.
- with `reported` left set: session 2 renders the notice with **`[data-playback-notice-reason]`
  absent entirely** — "no audio output" and no reason, for a session that failed for a new cause.
It opens NO "told more than once" hole: `clearPlaybackFailure()` is reachable only from
`newSession` (grepped — not from `reset()`, the transport swap, or any automatic path), and within a
session `reset()` still clears nothing, so `told EXACTLY ONCE` stays exactly true. That test could
not have caught this; the missing one is a SECOND-SESSION test.
**DECIDED:** add it.

### R3-3 (MINOR) — the BlindCompare arm of the funnel is unpinned
Mutation R2o SLIPPED: reverting `onPlay={playRun}` to `onPlay={(runId) => deps.playRun(runId)}` at
`ReplayView.tsx:583` leaves the suite green. The failure test drives `[data-run-play]` (RunsList)
only. The funnel is single today, but only one of its two call sites is defended — and blind compare
is where "I pressed play and heard nothing" costs most, since judging audio IS the task.
**DECIDED:** pin the BlindCompare call site too.

### R3-4 (MINOR) — `playbackUnavailableReason` sharing the gate is unpinned
Mutation R2p SLIPPED: making it ungated (`store.playbackFailureReason` raw) leaves the suite green,
because the view only renders the reason INSIDE the notice. The implementer's stated property —
"gated identically so the two can't disagree" — is therefore unenforced, and a future consumer
reading the reason alone would get a stale non-null value on a stopped or realtime session.
**DECIDED:** pin the controller property directly, not through the view.

## OPERATOR REAL-CHROME LIST (consolidated, unchanged plus one)
1. Replay's single reused context, once suspended by autoplay policy, actually RESUMES on the 2nd-10th press
2. The page stays under Chrome's per-document cap across a long QA pass, once capture contexts and the realtime in/outbound taps are counted WITH their async closes settling
3. `response.output_audio.delta` truly never arrives on the WebRTC data channel (040's finding — the mode gate now depends on it in a second place)
4. NEW: that a REAL transient recovery works — press New session after the cap frees and confirm cascade audio returns. `clearPlaybackFailure()` has only ever been exercised against a fake factory.

---

## ROUND 4 — re-review verdict: GREEN, two items landing anyway

34 mutations, **30 caught**. All three round-2 slips are closed (R2i by the second-session guard,
R2o by the blind-compare guard, R2p by the controller-level guard). R3-1's fix is verified genuinely
wired: `RecordTake` still calls `playTake?.(take)` with ONE argument, so the second argument the
seam receives can only come from the funnel's closure — with the raw forward, index `[1]` is
`undefined` and the locked assertion goes red.

**R3s was confirmed a genuine equivalent mutant, by enumeration rather than by failing to falsify
it:** `store.playbackFailureReason` has exactly one read site, always behind `playbackNotice`, which
requires `playbackUnavailable === true`; that flag has exactly one write site, and the callback
overwriting the reason runs in the same synchronous statement sequence inside `enqueue`, before
React can render. No render can observe the notice with a stale reason. Leaving it unpinned was
right. (The equivalence is a CONSEQUENCE of `clearPlaybackFailure()` clearing `reported`, which the
R3-2 guard now pins — so the coupling is safe.)

### R4-1 (MINOR, demonstrated) — the Replay notice can OUTLIVE what it describes
`ReplayView.tsx:416` and `:423` each open with `setPlaybackError(null)`. Removing it from EITHER
funnel leaves 1859/1859 green — neither is defended.
Demonstrated against the real `ReplayView` (press 1 fails, cap frees, press 2 sounds):
- HEAD: notice gone after the recovered press. Correct.
- Without the line: **the notice is still up, reading "No audio output — …" while the run is audibly
  playing.**
This is the Replay analogue of R2-1/R2-2, which were graded MAJOR on the LIVE side. And recovery is
MORE reachable here, not less: `replayPlaybackContextFactory` uses `??=`, so it retries
`new AudioContext()` on every press and each press builds a fresh `ArmPlayback` with a fresh latch —
so the first successful press after a Live capture context closes hits exactly this path.
**DECIDED:** land it. One test — fail, then succeed, assert the notice clears — closes both funnels.

### R4-2 (MINOR) — a comment that misnames its own reason
`RecordTake.tsx:117` claims the prop is *"Typed as the SEAM ITSELF … so this prop cannot drift back
out of step."* Refuted two ways: narrowing the prop straight back to one argument **compiles clean
and leaves all 1859 tests green**, and restoring `playTake={deps.playTake}` raw **also compiles
clean**. TypeScript's fewer-parameter function assignability makes both legal, so the type is not a
barrier in the dangerous direction.
Seam-typing IS a real single-source-of-truth improvement and does propagate changes to the seam's
first parameter — but **the funnel is what prevents R3-1 from returning**, and that is properly
defended (raw forward CAUGHT; funnel-drops-the-callback CAUGHT).
This repo's own precedent applies: the `browserDeps` comment nit got a source guard precisely
because *"a comment that misnames its own reason sends the next reader to delete the wrong half."*
**DECIDED:** correct the sentence — the funnel is the guarantee, the typing is hygiene. Also record
the corollary: with the funnel in place `RecordTake`'s prop arity is INERT, the reporter lives
entirely in the host. That is the right architecture and should be stated, not inferred.

### NOTED, no change — the `undefined`-preserving ternary is inert
Dropping it leaves the suite green, correctly: `[data-record-play]` renders unconditionally and the
funnel no-ops when the seam is absent. Defensible forward-looking defence if that button is ever
gated on the prop, but the stated rationale ("a host wiring no playback keeps its old prop shape")
describes nothing observable. Keep it; do not claim it does something.
