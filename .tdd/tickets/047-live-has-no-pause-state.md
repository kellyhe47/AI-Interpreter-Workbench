---
id: 047
title: Live always plays the translation immediately — remove the pause state entirely
status: green
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

---

## ROUND 3 — final review: one MAJOR defect, introduced by R2-3 (my call)

All eight R2 items landed; every round-1 mutation is now caught, including both halves of M6 and M7
(`browserDeps` dropping the constraints -> CAUGHT; muting the mic tracks -> CAUGHT; bracket-access
`pause()` before `enqueue` -> CAUGHT). R2-3's ordering claim was traced and is TRUE: the
transport-start effect gates on `TRANSPORT_STATUSES`, which excludes `idle` and
`requesting-permission`, so `attach` -> `play()` cannot run before the Start click AND the mic
grant. Reconnects re-enter through `attach` and inherit document-lifetime sticky activation.

### R3-1 (MAJOR, REGRESSION — introduced by R2-3) — a throwing `playbackContextFactory` wedges Live permanently
`useSessionController.ts:674`:
```
store.playback.play();      // constructs the AudioContext, SYNCHRONOUSLY
void requestCapture();      // never reached if the line above throws
```
`play()` -> `getContext()` -> `playbackContextFactory()` -> `new AudioContext()`, which **can
throw**: Chrome throws at the per-document AudioContext limit, Safari under some policy states. It
now runs BEFORE `requestCapture()`, in the same click handler, after `START` already dispatched.

**Proven by probe, not theorised.** With `playbackContextFactory` throwing `NotSupportedError`:
`startCapture` called **0** times, on the first click and every retry. React swallows the throw into
a guarded callback. `micPermission` is `'requesting'`, not `'denied'`, so no denied card renders —
no error, no recovery, no mic. `newSession`'s fallback `requestCapture` is unreachable from that
state. **Live is silently dead.**

It is more reachable than it looks: `browserDeps.ts`'s `playRun`/`playTake` construct a NEW
`AudioContext` per press and never `close()` it. Replay QA over a dozen runs, then Live -> Start, is
exactly Chrome's cap. R2-3 turned "cascade audio is silent" into "Live cannot start at all" — it
breaks the very thing it was added to protect.

**DECIDED:** keep the resume, make it best-effort and non-blocking. `void requestCapture()` FIRST
(it returns synchronously, so `play()` still runs in the same handler tick and keeps the gesture),
then `try { store.playback.play(); } catch { /* autoplay recovery is best-effort */ }`. Locked test:
a throwing `playbackContextFactory` must not prevent `startCapture`.

### R3-2 (MINOR) — the anti-gating guard is still bypassed by bracket access
**Mutation M10 SLIPPED, 1169/1169 green:** `t['enabled'] = false` on every mic track in
`browserDeps.ts`. Same evasion class as round 1's M7, which R2-6 closed on the PAUSE side but not
here — and there is no behavioural partner, because nothing drives a real `MediaStream` through the
Live capture path.
**DECIDED:** extend the pattern to `/(\.|\[\s*['"])(enabled|muted)(['"]\s*\])?\s*=[^=]/`. The guard
is a tripwire, not proof — say so in the test's own comment so nobody reads it as a guarantee.

### R3-3 (MINOR) — the guard keys on a property NAME across whole files
`realtime.ts` is ~750 lines; any future unrelated `this.enabled = false` trips a test whose message
says *"mutes and gates nothing — barge-in stays possible"*, which is not what went wrong.
**DECIDED:** constrain the receiver to something track-ish (plus the existing exact-line element
allow-list), so the guard fails for the reason it claims.

### R3-4 (MINOR) — the prose-scanning tests are fragile and have ALREADY distorted the source
`browserDeps.ts:146` reads *"The seam still exposes `play` and `pause` because…"* — visibly worded
to dodge a substring ban. `LiveView.autoplay.test.tsx:495` needs `['toggle','Play'].join('')` to
avoid tripping the repo-wide deletions manifest on its own source.
The ban is worth KEEPING for `browserDeps.ts:173`'s justification comment specifically — that line
asserted a recovery path that did not exist, which is exactly the lie that misleads the next author.
**DECIDED:** narrow each regex to the CLAIM rather than the vocabulary (e.g.
`/still has the play button|operator (still )?has.*play/i`), so a future author can legitimately
write "Replay's play/pause seam" without a red suite. Same for R2-4's `data-target-status` scan,
which today would fail a comment saying the value USED to exist.

### R3-5 (MINOR) — drop the redundant `!`
`browserDeps.inboundTap.test.ts:233` still writes `deps.remoteAudioSink!`; the field is non-optional
now. Harmless residue — remove it so non-optionality is visible at the call site. NOTE: that file is
ticket 046's lock; 046 is finished, so it may be edited now, by the test-writer only.

### ACCEPTED, NOT FIXED
Live now constructs an AudioContext at Start even for realtime sessions (which never use it) and for
sessions that end in permission denial. Verified NOT a leak: `useSessionController` mounts in `App`,
not `LiveView`, so Live<->Replay navigation does not remount it, and `ArmPlayback.reset()`
deliberately keeps `this.context` — exactly ONE context per app mount. One idle context is the price
of the resume; it is also the input to R3-1, which is why R3-1 must land.
Separately latent, NOT this ticket: `playRun`/`playTake` build a new `AudioContext` per press and
never close it.
