# Live smoke script — for checking the pipeline, not for evidence

**Nothing you say in Live becomes experimental evidence.** Live is free-form by design (§17 24b) and
its metrics are a soak measurement, never a latency sample — LiveSessions are never compared against
Runs. So read this loosely; the point is to confirm the pipeline works end to end and to hear the
interpreted audio come back.

Start on **Realtime (Arm A)**, then run it again on **Cascade** — the two take completely different
paths (browser→OpenAI over WebRTC vs. `/ws/cascade` to our server), and only the Realtime one has
been confirmed working since the `.env` fix.

Pause a beat between lines so each one endpoints as its own utterance.

---

## 30-second check — English → Spanish

> Good morning. Can you tell me what brought you in today?

> How long has the pain been there?

> Take one tablet twice a day with food.

> Do you have any allergies to medication?

Watch for: the source transcript filling in as you speak, a translation appearing, and audio playing
back (autoplay is on in Live). The arm card should read `ready`, not `failed`.

---

## Two-minute check — adds the things that break

Use this once the 30-second version works. It exercises the same stress categories the corpus does.

> Good morning, I'm the interpreter. Can you hear me clearly?

> What brought you in today?

> And how long has that been going on — days, or weeks?

> Take two hundred fifty milligrams twice a day, starting Monday the fourth.

> It started— sorry, I think it was Tuesday, no, Wednesday morning.

> Doctor Nguyen referred you to Cedars-Sinai for the MRI.

> If the swelling gets worse overnight, or if you notice any numbness in your left arm, stop the
> medication and call the after-hours line.

> Wait— before you go on, is she still taking the blood thinner?

> Any questions before we finish?

---

## The five-minute run

The rubric's stability benchmark is simply a Live session run for the **full five minutes**
(§17 19i) — there is no separate stability artifact. When you want that number, keep talking for
five minutes on any content; what matters is the *shape* of the cost curve over time, not what was
said. Repeating a short loop is actively wrong here — repeated content drives prompt-cache hits and
would flatten the very cost slope being measured (§17 24b).

---

## If it fails

- **Which arm** — Realtime and Cascade fail for different reasons and in different code.
- **Does the input meter move?** Moving meter = capture is fine, the problem is downstream.
  Dead meter = capture or permission.
- Realtime failures are opaque **by design** (§12) — the arm card will not name a stage. Cascade
  failures name the stage (`stt`, `mt`, `tts`). That difference is a finding, not a bug.
