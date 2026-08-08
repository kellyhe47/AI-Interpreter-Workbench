---
id: 046
title: Arm A produces no capturable output audio — its audio is a live media track, so nothing can be saved or replayed
status: tests-locked
source: qa-live
depends_on: [045]
touches: [src/client/transport/realtime.ts, src/client/replay/runner.ts, src/client/browserDeps.ts]
iterations: 0
test_files: [src/client/audio/inboundAudio.test.ts, src/client/browserDeps.inboundTap.test.ts, src/client/replay/replayArmA.test.ts, src/client/transport/realtime.test.ts, src/client/components/replay/RunsList.playGate.test.tsx, src/client/replay/runner.outputAudio.test.ts, src/client/replay/runner.test.ts]
branch: ""
---

## Why

Ticket 045 gives runs an upload path, which fixes **cascade** playback. It cannot fix Arm A.

Confirmed empirically in ticket 040: over WebRTC, OpenAI sends audio on the **media track only** —
`response.output_audio.delta` does not exist. `onAudio` in `src/client/transport/realtime.ts:468`
fires only from that event, so for Arm A `audioChunks` is empty and `outputAudio.length === 0`.
There is nothing to upload, and `blind compare` — which is playback-only by design (PRD §10) — has
nothing to play for any pair involving Arm A.

**This is a playback and evaluation gap, not a measurement gap.** Arm A's `audio_queued` comes from
`output_audio_buffer.started`, so every latency and cost figure is already correct.

## Scope

Tap the INBOUND remote stream so Arm A's output audio can be captured to the same 24 kHz PCM16 the
cascade path produces — a Web Audio tap on the remote `MediaStream`, or an equivalent seam.

## Acceptance criteria

- [ ] An Arm A Replay run produces non-empty output audio, uploaded by 045's path, and
      `GET /api/runs/:id/audio` returns it
- [ ] The captured audio is **24 kHz PCM16 mono**, matching cascade's, so the two arms are
      comparable and blind compare cannot be told apart by format
- [ ] **Capturing must not perturb the measurement.** `audio_queued` still comes from
      `output_audio_buffer.started` and does not shift; adding a tap must not delay or reorder the
      inbound path.
- [ ] Live is unaffected — it already plays through the `remoteAudioSink` (040) and persists no audio
      at all (§17 19h). A tap must not cause Live to start storing audio.
- [ ] The tap is an **injectable seam**; jsdom has no `AudioContext` and no `MediaStream`, and the
      existing realtime fakes must keep working untouched
- [ ] Blind compare can play an Arm A sample, so an A-vs-B pair is judgeable
- [ ] Nothing autoplays in Replay

## CONTEXT A SUB-AGENT NEEDS — everything below was established empirically, do not re-derive

### 1. Why Arm A has no audio (settled in ticket 040, do not re-investigate)

A real Realtime session was instrumented in the operator's Chrome: `RTCPeerConnection` patched to
capture every `ontrack` and every data-channel event type, then the model was driven to speak with
NO microphone via `conversation.item.create` + `response.create`. Result:

```
inbound audio RTP                        42,153 bytes / 748 packets   <- audio IS on the media track
ontrack fired                            kind: 'audio'
response.output_audio.delta              NOT PRESENT
response.output_audio_transcript.delta   9   (TEXT, not audio)
output_audio_buffer.started / .stopped   1 / 1
```

**Over WebRTC, OpenAI sends audio on the MEDIA TRACK only.** `onAudio` in
`src/client/transport/realtime.ts:468` fires ONLY from `response.output_audio.delta`, which does not
exist on this transport — so `audioChunks` is always empty for Arm A and `outputAudio.length === 0`.

### 2. What already exists — build on these, do not rebuild

- **`RemoteAudioSink`** (ticket 040, `src/client/transport/realtime.ts`) —
  `{ attach(stream), play(), pause() }`, injected via `RealtimeDeps.remoteAudioSink`. `connect()`
  installs `pc.ontrack` BEFORE `setRemoteDescription` and calls `attach(ev.streams[0])` for an
  audio track. **This seam already receives exactly the stream the tap needs.**
- **`OutboundAudioSink`** (ticket 043, `src/client/audio/outboundAudio.ts`) — the OUTBOUND mirror,
  a factory building an `AudioContext` at 24 000 Hz + `MediaStreamAudioDestinationNode`. Its shape
  and its 24 kHz discipline are the pattern to copy for the inbound tap.
- **The upload path** (ticket 045, green): `RunsClient.uploadAudio(id, wavBytes)` ->
  `POST /api/runs/:id/audio`. `runOnce` uploads **BEFORE** POSTing the Run and stamps the
  server-reported `outputAudioPath`. A run with zero samples uploads nothing — which is why Arm A
  currently stores nothing. **Once the tap produces samples, the existing path uploads them with no
  further change.**
- **The play gate** (ticket 045): `[data-run-play]` renders iff
  `run.outputAudioPath !== undefined`, else `[data-run-no-audio]` ("no output audio stored"). So an
  Arm A run gains its play button automatically once audio is captured.

### 3. Where the wiring goes — and where it must NOT

`browserDeps.ts` has two transport factories. Ticket 043 learned this the hard way:

- **DO** wire the tap into **`buildReplayDeps`'s `createTransport` realtime branch** — Replay is
  where a Run is produced and where output audio must be stored.
- **DO NOT** wire it into `buildBrowserDeps`'s Live `transportFactory`. Live persists no audio at
  all (§17 19h), and Live's controller already drives the same inbound stream through
  `remoteAudioSink` for playback. A tap there would start Live storing artifacts the design
  deliberately excludes.

### 4. Test discipline

- jsdom has **no `AudioContext`, no `MediaStream`, no `MediaRecorder`** — the tap MUST be an
  injectable seam, exactly like `remoteAudioSink` and `createOutboundAudioSink`.
- The existing realtime fakes (`FakePc`, `FakeTrackPc`, `makeHarness`, `trackDuringAnswer` in
  `src/client/transport/realtime.test.ts`) must keep working untouched — extend that harness rather
  than inventing a second one.
- `src/client/replay/replayArmA.test.ts` is the end-to-end Arm A shape from 043; extend it rather
  than starting fresh.
- **Include a falsifiability control**, as 043 did: a test proving the fake produces audio only
  because the tap captured it, not because a timer fired. Without one, the positive tests are
  satisfiable by a stopwatch.

### 5. The measurement must not move

`audio_queued` for Arm A comes from `output_audio_buffer.started` (ticket 040), NOT from audio
bytes. Attaching a tap must not delay, reorder or buffer the inbound path in a way that shifts it.
**Assert the timing is unchanged with the tap attached** — this is the one way this ticket could
silently corrupt a figure that currently works.

## Notes

- 040's `remoteAudioSink` already receives the inbound stream for Live playback. The Replay tap is
  the same stream consumed for a different purpose — consider whether one seam can serve both
  rather than attaching two consumers to one track.
- Do not reintroduce a PCM-delta expectation; it does not exist on this transport.
- Do not run `prettier` — this repo has no config and it reformats unrelated regions.

---

## ROUND 2 — code review findings (independent reviewer, against `905907a`)

The implementation was green (1726/1726, both typechecks) and AC3/AC4/AC5 were verified genuine by
mutation. Four things must change before this ships.

### R2-1 (BLOCKER, test falsifiability) — the production wiring is not pinned
`browserDeps.inboundTap.test.ts` splits the source on `export function buildBrowserDeps` and asserts
`replayHalf.includes('createInboundAudioTap')` — which the IMPORT LINE alone satisfies. Verified:
deleting the whole `createInboundAudioTap` property from `buildReplayDeps` leaves 1726/1726 green.
There is no lint script to catch the orphaned import. Assert on the CONSTRUCTED object, the way the
Live half already correctly does.

### R2-2 (BLOCKER, test falsifiability) — the Web Audio graph connectivity is not pinned
The fake calls `onaudioprocess` directly, so no test depends on any node being connected. Verified:
deleting ALL THREE `connect()` calls leaves the suite green. In a real browser an unconnected
ScriptProcessor is never pulled -> zero frames -> Arm A silently uploads nothing. Assert the edges:
source -> processor -> gain -> `ctx.destination`, which also makes the AC7 gain-0 test non-vacuous.

### R2-3 (MAJOR, real-browser risk) — Replay never sinks the remote stream to an element
`buildReplayDeps` wires no `remoteAudioSink`, so the remote `MediaStream` goes straight into
`createMediaStreamSource`. Chromium has a long history of delivering SILENCE from a remote WebRTC
stream into Web Audio unless the stream is also sunk to a media element.
**DECIDED:** reuse the seam that already exists rather than adding a second one — wire a **muted**
`remoteAudioSink` into `buildReplayDeps`. Muted satisfies "nothing autoplays in Replay" (§7: no
sound is produced) while keeping the stream pulled. This is what the ticket's own Notes anticipated:
one seam serving both purposes.

### R2-4 (MAJOR, spec) — matching FORMAT is not enough; the CONTENT unblinds the comparison
The tap runs continuously from track-attach to `stop()`, so an Arm A file is the whole ~45 s run —
leading silence, inter-utterance gaps, comfort noise. Cascade's is the concatenation of TTS chunks
only: gapless speech, a few seconds. `BlindCompare` plays the whole stored WAV, so an evaluator
tells the arms apart in the first second — AC2's wording is met, its PURPOSE is defeated. It is also
~2 MB per run, ~130 MB per 60-run arm.
**DECIDED:** gate capture to the model's speaking windows. The transport already receives
`output_audio_buffer.started` / `.stopped`; it toggles the tap, and captured windows concatenate.
- The tap gains an explicit capture gate; frames outside a window are DROPPED, not buffered
- A **tail grace** after `.stopped` (250 ms, a named constant) so the last syllable is not clipped —
  this also covers the truncation the reviewer flagged separately
- **This must not touch AC3.** The gate READS the same two events; it must not change when, whether,
  or in what order `audio_queued` is stamped. Keep the tapped-vs-no-tap timing-identity test and
  extend it to cover the gated path.

### R2-5 (MINOR) — reuse `floatTo16`
`inboundAudio.ts` reimplements `src/client/audio/pcm.ts:floatTo16` with a DIFFERENT scale convention
(`v*32768` clamped vs pcm.ts's asymmetric `v<0 ? v*32768 : v*32767`). Two client capture paths that
can drift apart by 1 LSB and then independently. Use `floatTo16`; if a locked expectation encodes
the other convention, the test-writer changes the expectation.

### R2-6 (MINOR) — the runner's fallback condition is unpinned
`runner.ts:578`'s `audioChunks.length === 0` guard can be replaced with `if (true)` and the suite
stays green. The condition is CORRECT (cascade defines no `takeOutputAudio`) but unprotected. Pin
it: a transport yielding BOTH `onAudio` chunks and a `takeOutputAudio()` uploads only the decoded
chunks.

### R2-7 (MINOR) — await the context close
`void ctx.close()` is fire-and-forget and a realtime Replay run builds TWO AudioContexts (outbound
sink + inbound tap). Chrome caps concurrent hardware contexts (~6); across a 60-run sweep a lagging
close can make construction throw and kill a run. Await it, or state why not.

### ACCEPTED, NOT FIXED
- ScriptProcessorNode is deprecated and main-thread; a starved main thread can drop frames. It does
  NOT affect measurement (`audio_queued` is a data-channel event). Revisit only if a real capture
  comes back short.
- AC1 is not fully provable in vitest. It stays unproven until a real Arm A Replay run in Chrome
  returns audible speech from `GET /api/runs/:id/audio` — an operator smoke test, not a unit test.

---

## ROUND 3 — re-review of `905907a..6f23b64`

All seven R2 items verified genuinely fixed AND genuinely pinned: every round-1 mutation now fails,
plus 14 new ones (gate always open -> 4 fail; tail grace 0 -> 3; gate opened before the
`audio_queued` stamp -> 4; un-awaited stop -> 1; and so on). AC3 was re-traced and mutation-proven
to survive the gate. The R2-1 and R2-2 holes that made the whole ticket deletable are closed.

One blocker and five cheap follow-ons.

### R3-1 (BLOCKER) — `await transport.stop()` is an UNBOUNDED wait
`runner.ts:572` -> `realtime.ts:649` -> `inboundAudio.ts:254`. Nothing races it. `startBatch`'s
`runTimeoutMs` only calls `controller.abort()` (`batch/runner.ts:302`); it does NOT race
`await deps.execute(...)`, and `runOnce` observes the abort signal nowhere after `await
pacer.start()`. So if Chrome wedges an AudioContext — device change or removal is the classic cause
— and its `close()` never settles: the run sits "running" forever, the SWEEP STOPS ADVANCING, no Run
is stored, no error is reported, and `runTimeoutMs` never fires. **Round 2 traded a bounded leak for
an unbounded stall of the whole experiment.**
The code's own comment refuses this trade for *rejection* ("a wedged context is not something a run
can act on, and failing the run over it would lose the measurement") — but it is the WAIT, not the
rejection, that loses the measurement.
**DECIDED:** bound it. `TRANSPORT_CLOSE_TIMEOUT_MS = 2000`, a named exported constant;
`await Promise.race([transport.stop(), delay(TRANSPORT_CLOSE_TIMEOUT_MS)])`. The existing
`holdClose` harness pins it: hold the close, advance past the budget, assert the run resolves and
still uploads. Today's test resolves the close by hand — "never resolved" is untested.

### R3-2 (MAJOR in effect) — the 250 ms tail grace is shorter than the receiver's jitter buffer
`inboundAudio.ts:61`. `output_audio_buffer.stopped` rides the DATA CHANNEL, which has no jitter
buffer; the audio it refers to is still in NetEq. The grace must cover the END-TO-END AUDIO DELAY,
not "a syllable" — Chrome's NetEq target delay is commonly 60-150 ms and expands to several hundred
on a jittery link. Exceeded, the last word of EVERY Arm A utterance is clipped silently, and a blind
evaluator hears that as a defect of the ARM — the exact attribution error this project exists to
prevent. R2-4's unblinding concern is about multi-second gaps, so being generous is nearly free.
**DECIDED:** raise to `INBOUND_TAIL_GRACE_MS = 750`. The operator smoke test must confirm the final
syllable survives.
Worth stating explicitly in the header: the ONSET side is safe — the gate opens on an event that
LEADS its audio, so a window can only admit extra leading silence, never clip an onset.

### R3-3 — "the gate never opened" is indistinguishable from "the model never spoke"
`inboundAudio.ts:148`: `admit()` drops frames without counting them. Capture now depends on a
data-channel event; if `output_audio_buffer.started` ever stops arriving, Arm A stores nothing and
the artifact looks exactly like a mute model. AC1 is explicitly deferred to an operator smoke test,
and that smoke test currently CANNOT TELL THE TWO APART.
**DECIDED:** count dropped samples and expose them, so a smoke run can report "12 s of track seen,
0 admitted". This is what makes the one unprovable AC diagnosable.

### R3-4 — `outputWindowOpen` bookkeeping is untested in both directions
`realtime.ts:585` and `:636`. Verified: removing `this.outputWindowOpen = false` from the `.stopped`
branch, OR from `stop()`, each leaves 1758/1758 green. The first is a real bug if it regresses — a
reconnect after the model finished would `startWindow()` on attach and record the inter-utterance
gap, precisely the unblinding R2-4 exists to prevent.
**DECIDED:** pin it. `.started`, `.stopped`, then a reconnect track event; assert `windows()` gains
no third `start`.

### R3-5 — the R2-1 seam pins the PUBLISHED factory, not the one `runOnce` is bound to
`browserDeps.ts:296`, `ReplayView.tsx:224`. Verified: publishing the correctly-wired
`createTransport` while binding `runnerDeps.createTransport` to a second, UNWIRED factory leaves
1758/1758 green. Today they are the same const so production is correct, but the guarantee is weaker
than the docstring claims.
**DECIDED:** extend the source-text belt to pin the BINDING, e.g.
`expect(REPLAY_DEPS_SOURCE).toMatch(/const runnerDeps: RunnerDeps = \{[^}]*\bcreateTransport,/s)`,
and label the seam in its docstring as partly test-shaped.

### R3-6 — R2-7's rationale is half-implemented; `outboundAudio.ts` is a genuine leftover
`outboundAudio.ts:121` is still `close(): void { void ctx.close(); }` and `realtime.ts:646` calls
`sink?.close()` un-awaited — so a realtime Replay run still leaves one of its TWO contexts closing
unobserved, while `runner.ts:566` explains the await by saying the run holds two.
**DECIDED:** fix it here rather than deferring — it is the same defect, and a comment claiming
protection the code does not give is worse than either. Mirror the awaited close in the outbound
sink and have `stop()` await both via `Promise.all`, under the SAME `TRANSPORT_CLOSE_TIMEOUT_MS`
bound from R3-1. `outboundAudio.test.ts` is ticket 043's lock — the test-writer updates it.

---

## ROUND 4 — final review verdict: GREEN, with two minor items to land first

Regression battery: 17/17 rounds 1-2 mutations still fail, and the `.stopped`/`outputWindowOpen`
mutation that SURVIVED round 2 is now killed (R3-4 landed). Round-3 battery: 12 of 14 fail. The two
survivors — arming a timer when there is nothing to close, and dropping the `void` on the
reconnect-time close — are unobservable by construction (the timer is cleared either way so nothing
leaks; `void` is a lint marker on a promise that cannot reject). Left alone, as with the `stop()`
reset.

### R4-1 — the diagnostic's premise is FALSE in a real browser, and the smoke test is its consumer
`runner.ts:683`, comments at `runner.ts:671` and `types.ts:158`. The condition
`dropped > 0 && admitted === 0` assumes an honestly-silent run yields `{0,0}`. True of the `mute`
harness, which delivers nothing to the fake tap — **not true of Chrome**: once the ScriptProcessor
is connected the graph is pulled continuously and the receiver renders silence frames whether or not
any RTP arrives. So in production `{0,0}` is essentially unreachable for a connected run, and BOTH
"the gate is stuck" AND "the model never spoke" present as `{n, 0}`.
The line stays literally accurate but its label points at capture when the cause may be the model —
and R3-7 exists precisely so the operator can tell those apart. It also fires on a cancelled run
stopped before the model spoke.
No measurement risk (verified again: cannot fail a run, cannot touch `status`, and
`isAggregatableRun` reads `armTag`/`origin`/`status`/realness, never `errors`).
**DECIDED:** add the conjunct — the value is already in scope, immediately below the block.
`stats.dropped > 0 && stats.admitted === 0 && typeof timings.audio_queued === 'number' && !cancelled`
— i.e. "the model demonstrably started an output buffer and nothing was admitted", a genuinely stuck
gate. Correct both comments: the real silent-run signature is `{n, 0}` with NO `audio_queued`, not
`{0,0}`. Land BEFORE the smoke test.

### R4-2 — `transport.stop()` is evaluated outside every guard
`runner.ts:646`: `await closeTransport(transport.stop(), TRANSPORT_CLOSE_TIMEOUT_MS)`.
`closeTransport` guards rejection (`.catch`) and hanging (the race) — but the CALL is outside both.
A synchronous throw from a close (a mock, an older or patched implementation) rejects `runOnce` and
stores no Run, losing the measurement — the exact trade the surrounding comments refuse twice.
Pre-existing since round 2.
**DECIDED:** take a thunk — `closeTransport(() => transport.stop(), …)` with the call inside the
`try`.

### R4-3 (no code change) — the diagnostic is invisible on screen, by design
`RunsList.tsx:270` computes `failureOf(run)` only when `status === 'failed'`, so a COMPLETE run
carrying `CAPTURE_GATE_NEVER_OPENED` renders nothing. That is correct — a complete run must not
display a failure stage — but per AGENTS.md ("a derivation holding the right answer is not the same
as a screen showing it") the smoke procedure must read `GET /api/runs/:id` or the exported ledger,
NOT the screen. Record it in the smoke instructions.

### R4-4 — filed separately, NOT in this ticket
R3-1 bounds the close, but two unbounded waits remain in `runOnce`: `uploadOutputAudio` ->
`runs.uploadAudio` is a bare `fetch` with no timeout (`runner.ts:264`), and `await finished` is
unbounded for mic-shaped (manifest-less) runs. Same shape as the stall R3-1 fixed — `startBatch`'s
`runTimeoutMs` still only aborts a signal nobody reads after pacing, so a hung upload freezes a
sweep exactly as a wedged context would have. Both pre-existing and out of scope here.

## WHAT REMAINS UNPROVEN — the operator smoke test in real Chrome

Every test runs on fixtures by policy; the entire real-transport path is unexercised by
construction. One Arm A Replay run answers all of this:

1. **AC1 itself** — `GET /api/runs/:id/audio` returns AUDIBLE SPEECH
2. **R2-3's premise** — that a MUTED `<audio>` element is enough to keep Chromium feeding real
   samples into `createMediaStreamSource` from a remote WebRTC stream. **If the capture comes back
   all zeros, this is the suspect.**
3. **R3-2's 750 ms** — listen to the LAST WORD of each of the four utterances
4. **The gate's real onset** — no speech onset lost, i.e. `output_audio_buffer.started` really does
   lead its audio on the wire
5. **Chrome's concurrent-AudioContext headroom across a full 60-run sweep**
6. Check `run.errors` in the STORED JSON for `output audio capture: gate never opened` — it will not
   appear on screen (R4-3)
