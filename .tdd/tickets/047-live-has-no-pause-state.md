---
id: 047
title: Live always plays the translation immediately — remove the pause state entirely
status: pending
source: operator
depends_on: []
touches: [src/client/views/LiveView.tsx, src/client/views/useSessionController.ts, src/client/browserDeps.ts]
iterations: 0
test_files: []
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

## OPEN QUESTION FOR THE OPERATOR — do not implement past this without an answer

In Live the microphone is open **while the translation plays out loud**. On speakers (not
headphones) the model can hear its own output, and that audio would be transcribed as if the
operator had spoken it — corrupting the very session being measured. Removing pause removes the
only way to silence output mid-session.

Options: (a) no control at all, accept that Live requires headphones, and say so in the UI;
(b) a **mute** that silences output without suspending anything — no "pause state", but a way to
stop feedback. Awaiting the operator's answer; (a) is what the ticket currently specifies.
