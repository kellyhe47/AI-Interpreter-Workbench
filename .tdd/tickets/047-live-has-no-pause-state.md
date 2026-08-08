---
id: 047
title: Live always plays the translation immediately — remove the pause state entirely
status: tests-locked
source: operator
depends_on: []
touches: [src/client/views/LiveView.tsx, src/client/views/useSessionController.ts, src/client/audio/capture.ts, src/client/replay/capture.ts]
iterations: 0
test_files: [src/client/views/LiveView.autoplay.test.tsx, src/client/views/LiveView.flow.test.tsx, src/client/audio/capture.test.ts]
branch: ""
---

## Why — operator decision

> *"Let's just always immediately play the translated audio. I don't think it makes sense for us to
> ever have a pause state in live mode."*

The control was never a replay button and could not become one: audio is consumed as it arrives and
nothing is retained (`ArmPlayback.play()` drains its queue and empties it; realtime plays a live
WebRTC `MediaStream`, which has no timeline to seek in). So "play/pause" means *resume/suspend the
live feed* — which is a control nobody wants during a ≤5-minute measured conversation.

It also behaves **inconsistently between arms**, which is its own argument for deleting it:

| | pause, then play |
|---|---|
| Cascade | the audio clock is suspended, so audio arriving meanwhile is scheduled into a frozen clock and plays LATE on resume |
| Realtime | a live stream is paused, so whatever arrived meanwhile is GONE |

Neither is replay. One is delay-then-catch-up, the other is skip.

This also aligns the UI with what the PRD already says: **"Live: autoplay on"** — unconditional
(§7, §17 19-series). A pause control contradicts a rule the rest of the system treats as fixed, and
`useSessionController` already documents playback as "autoplay ALWAYS on".

## Scope

Remove the pause state from Live. Autoplay is the only behaviour.

## Acceptance criteria

- [ ] The Live view renders **no play/pause control at all** — not a disabled one
- [ ] Translated audio plays **immediately and unconditionally** on arrival, in BOTH arms
      (cascade via `ArmPlayback`, realtime via the `remoteAudioSink`)
- [ ] `actions.togglePlay` is **gone** from the session controller's surface — not merely unused;
      a dead action is a control someone re-wires later
- [ ] Nothing in Live can leave audio suspended: there is no code path that calls `pause()` /
      `suspend()` on the Live playback or sink
- [ ] The **utterance duration readout** the button carried (`{durationMs/1000} s`) is KEPT — it is
      information, not a control. Decide where it sits and state it.
- [ ] Live still persists **no audio** and creates **no Run records** (§17 19h) — unchanged
- [ ] **Replay's play controls are untouched.** They are a different thing: on-demand playback of a
      stored run, deliberately not autoplay (PRD §7, "nothing autoplays in Replay"). Only Live loses
      its control.
- [ ] `ArmPlayback`'s and `RemoteAudioSink`'s `pause()` methods may remain on the seams if Replay or
      a future caller needs them — but Live must never invoke them. State which you chose.

## Test criteria

- A Live session renders no element matching a play/pause affordance, in every session state
  (`listening`, `speaking`, `switch-queued`, `stopping`) — a table over states, so it cannot come
  back in one branch
- Audio arriving mid-session reaches the sink/playback **without any user action** — assert the
  sink recorded playback with zero clicks
- **Realtime**: the inbound stream is attached and playing with no interaction (040's path)
- **Cascade**: enqueued PCM starts immediately rather than buffering (`autoplay: true` semantics)
- A source-level guard that Live invokes no `pause`/`suspend` — the same shape as the existing
  source-grep guards, so a future edit cannot quietly reintroduce it
- The duration readout still renders and still tracks the current utterance
- REGRESSION: Replay's `[data-run-play]` and BlindCompare's play controls are unaffected

## KNOWN LOCKED-TEST CONFLICT — resolve through the test-writer, do not work around

`src/client/views/LiveView.flow.test.tsx:548` asserts `expect(audio.calls).toEqual(['play','pause'])`
— ticket 040's proof that `togglePlay` drove the real remote sink. **This ticket deliberately
removes that behaviour**, so the assertion is now wrong rather than the code. Rewrite it to pin what
040 actually cared about — that the inbound stream reaches the sink and sounds — without the manual
toggle.

Unrelated and must stay green: `App.test.tsx:432`, `ReplayView.test.tsx:897/913` — those are
Replay/blind-compare play buttons.

## RESOLVED — the feedback question (operator decision)

The concern: in Live the microphone is open while the translation plays out loud, so on speakers the
model could hear its own output and transcribe it as if the operator had spoken.

**It is already handled, implicitly.** `src/client/audio/capture.ts:91` calls
`getUserMedia({ audio: true })`, and browsers default `echoCancellation: true` for a bare
`audio: true`. **Confirmed empirically by the operator**: during Live testing the model spoke back
on autoplay and never transcribed its own output.

### Considered and REJECTED: gating the microphone while output plays

The operator proposed muting input during output — the standard half-duplex fix. Rejected after
analysis, with the operator's agreement, because it would cost more than it buys:

- **It kills barge-in.** The transport sends `turn_detection: { type: 'server_vad',
  silence_duration_ms: 500 }`; Realtime handles barge-in natively while cascade is turn-based.
  Suppressing it would hide a genuine architectural difference and make Arm A look more like
  cascade than it is — the exact distortion this project exists to prevent.
- **It can drop real speech.** Anything said during the output window would be lost, so a session
  could under-count utterances with no error surfaced.
- **It layers a SECOND gate on a pinned control.** AGENTS.md: "VAD pinned at
  `silence_duration_ms: 500` in every arm. A measurement control, not a knob." A client-side gate on
  top changes when speech reaches the provider, in Live only — Replay would not have it.

### DECIDED: make the browser default EXPLICIT instead

- [ ] `getUserMedia` requests the constraint rather than inheriting it:
      `{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }`
- [ ] It is a **declared control**, documented beside VAD and endpointing — the same discipline used
      everywhere else in this codebase. A browser changing its default must not silently change the
      experiment.
- [ ] The capture seam's type widens from `{ audio: true }` to carry the constraint object; the
      existing injected fakes keep working (they ignore the argument)
- [ ] **No input gating anywhere.** Barge-in stays possible; nothing mutes the microphone.

## Test criteria for the constraint

- `startCapture` passes the explicit constraint object through to the injected `getUserMedia` —
  assert the exact object, so a future edit cannot silently drop a field
- Every existing capture test still passes with the widened type
- No code path mutes or gates the microphone during output (source-level guard, same shape as the
  no-pause guard above)

---

## ROUND 2 — code review findings (independent reviewer, against `345fb6c`)

Reviewed on a clean snapshot: 102 files / 1798 tests green, both typechecks clean. Every AC is
satisfied in the SHIPPED behaviour — the reviewer could find no way Live still pauses, still renders
a control, or still inherits an implicit constraint. Nine mutations run; two slipped.

### R2-1 (MAJOR) — Part 2's headline claim is untested, and the anti-gating guard omits the only files holding a `MediaStreamTrack`
**Mutation M6 SLIPPED, 1147/1147 green + typecheck green:** rewrote the Live forward in
`browserDeps.ts` to `getUserMedia({ audio: true })` AND added
`for (const t of stream.getAudioTracks()) t.enabled = false;`. The ticket's headline requirement
silently reverted *and* the microphone hard-muted, with nothing red.
The wiring is correct TODAY (`browserDeps.ts:428` forwards `LIVE_CAPTURE_CONSTRAINTS` verbatim, and
`CaptureConstraints` is structurally assignable to `MediaStreamConstraints`) — but nothing pins it,
and the mic-gating guard scans only `capture.ts`, `useSessionController.ts`, `LiveView.tsx`.
`browserDeps.ts` was deliberately untouched by 047, so no reviewer looks there.
**DECIDED:**
- Extend the `.enabled =` / `.muted =` guard to `src/client/browserDeps.ts` and
  `src/client/transport/realtime.ts`, with an explicit exemption for `el.muted = options.muted` —
  that is ticket 046's Replay silent-sink on an AUDIO ELEMENT, not the microphone
- Pin the production forward: stub `navigator.mediaDevices.getUserMedia`, call
  `buildBrowserDeps().startCapture({...})`, assert the received argument deep-equals the constraint
  object. Same shape as the existing "production Live sink PLAYS on attach" test.

### R2-2 (MAJOR) — `SessionDeps.remoteAudioSink` is a dead field on the controller's surface
`useSessionController.ts:154` is its ONLY occurrence in the file; never read. In production the sink
Live actually hears is the one `browserDeps.ts:378` closes over and hands to the TRANSPORT factory.
This is the same landmine the ticket deleted `togglePlay` to avoid — *"a dead action is a control
someone re-wires later"* applies verbatim to a dead dependency. It also means
`expect(audio.calls).not.toContain('pause')` in three tests can only ever catch
CONTROLLER-originated pauses, never one introduced in `realtime.ts` or `browserDeps.ts`.
**DECIDED:** delete it, with its `makeDeps` plumbing. Keeping a dead seam while deleting a dead
action for the stated reason is incoherent. The extended source guards from R2-1 are what replace
the (illusory) coverage.

### R2-3 (MINOR, but the one with a user-visible failure mode) — autoplay-rejection recovery is gone
Four stale comments in `browserDeps.ts` (`:131`, `:161`, `:173`, `:377`) describe a control that no
longer exists. `:173` is not just prose — it is the JUSTIFICATION for
`void node.play?.()?.catch(() => {})`: *"a rejected autoplay is not a failure worth surfacing: the
operator still has the play button."* With the button gone, a rejected autoplay is swallowed with no
recovery and no surfaced error — a silent realtime session with no affordance. Same class on the
cascade side: `ArmPlayback.play()` is the only `ctx.resume()` in the client (`playback.ts:156`,
documented at `:21` as the autoplay-policy recovery) and now has ZERO non-Replay callers, so a
context that starts `suspended` never recovers.
Low probability — "Start microphone" gives Chrome sticky activation first, and the mic grant exempts
the element autoplay policy — and NOT a new failure, since autoplay already worked without the
button. But the fallback is gone and the comments now assert a lie.
**DECIDED:** fix all four comments, and call `store.playback.play()` once from the `start` action,
inside the real user gesture, purely to force `ctx.resume()`. That reintroduces no control and trips
no locked guard (the source greps target `pause`/`suspend`/`togglePlay`, never `play`).

### R2-4 (MINOR) — `LiveView.tsx:62` still advertises `'playing'`
The removal of the `playing` branch was traced hardest and is CORRECT: `status: 'playing'` is set at
exactly one place (`sessionMachine.ts:280`, `case 'PLAY'`), `dispatch({type:'PLAY'})` occurs nowhere
in `src/` outside tests, `RECONNECTED` cannot manufacture a status nothing can enter, and
`TargetView.status` is only `'in-flight' | 'ready' | 'failed'`. Nothing outside `LiveView.tsx` and
its tests reads the attribute. **Only the doc line lies.** Drop `'playing'` from line 62.

### R2-5 (MINOR) — orphaned machine states: KEEP, and say so
`PLAY` / `PLAYBACK_ENDED` / `status: 'playing'` are now unreachable, and `'playing'` remains in six
lists (`ACTIVE_STATUSES`, `TRANSPORT_STATUSES`, `STOPPABLE_STATUSES`, `TICKING_STATUSES`,
`LIVE_STATUSES`, the `REQUEST_SWITCH` queueing condition).
**DECIDED: keep them.** Removing `'playing'` from the union breaks the locked state-table test that
deliberately pins "no button even in `status: 'playing'`" — a hedge worth keeping, since it is what
catches a reintroduction that goes through the machine. Document them as deliberately retained.
**AGENTS.md convention applies instead:** add `togglePlay`, `onTogglePlay`, `PlayGlyph`, `PauseGlyph`
to `src/client/deletions.test.ts` — *"Deleted code has no test of its own; that guard is what keeps
it deleted."* 047 greps two files where the repo's stated mechanism is that manifest.

### R2-6 (MINOR) — the anti-pause behavioural guard is single-chunk-shallow
**Mutation M7 SLIPPED, 1147/1147 green:** `remoteAudioSink['pause']()` + `store.playback['pause']()`
inserted at the top of `onAudio`, BEFORE `enqueue`. Bracket access dodges the `/\.pause\s*\(/`
regex; the pre-enqueue placement dodges `rec.suspends === 0`, because on the first chunk
`this.context` is still null and the cascade fixture emits exactly ONE chunk. Live would suspend its
own context on every chunk after the first, suite green.
The same edit AFTER `enqueue` IS caught (M8). **DECIDED:** give the cascade fixture >= 2 audio
chunks and assert over multiple chunks. A regex guard alone cannot survive bracket access.

### R2-7 (MINOR) — `LIVE_CAPTURE_CONSTRAINTS` also governs REPLAY's corpus recording
`replay/capture.ts:136` forwards into `startCapture`, which now hardcodes the constant — so
`startTake` requests the same three constraints. Behaviourally a no-op in Chrome and arguably
correct (one microphone path), but the NAME says LIVE, and someone tuning "the Live mic control"
would silently change how the CORPUS is recorded — upstream of every WER and latency number.
**DECIDED:** keep the name (it is pinned by a locked test), and document the inheritance explicitly
at `replay/capture.ts`.

### R2-8 (MINOR) — test-file coupling
`LiveView.autoplay.test.tsx:40` imports `../deletions.test`, re-executing all 11 `ticket-012 DELETE
manifest` suites inside the autoplay file; only 25 of its 36 tests are 047's, and a deletions
failure reports under an unrelated file. Move `stripComments` into a non-`.test` helper module.

### VERIFIED CORRECT (reviewer, mutation-backed)
`togglePlay` gone from the type AND the actions object, pinned by `Object.keys(actions).sort()`
equality rather than a grep (M3 caught). Button/glyphs/props deleted, no orphaned styles, no unused
imports. Duration readout kept and now renders after stop too (M2 caught, 8 failures). Cascade
autoplay pinned behaviourally (`started === [50400]`, `suspends === 0`); realtime autoplay pinned
against the PRODUCTION `buildBrowserDeps()` sink, not a fake. Replay/BlindCompare untouched — the
`replay/capture.ts` change is type-only. The `play2.1 s` vacuity trap is properly handled: the
leading-boundary-only matcher hits `play2.1 s` and correctly misses the `autoplay on` caption, and
`readyTarget()` sets `hasData: true` so the table exercises the branch the button lived in (M1
caught, 19 failures).
