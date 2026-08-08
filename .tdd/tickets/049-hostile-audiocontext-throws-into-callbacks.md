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
