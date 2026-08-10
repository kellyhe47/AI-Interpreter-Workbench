---
id: 073
title: "Three artifacts claim Realtime cannot do Cantonese — the constraint belongs to a model this project does not use"
status: pending
source: operator observation (2026-08-10) — "In real-time mode, English to Cantonese outputs Cantonese"
depends_on: [062]
touches: [src/client/views/ResultsView.tsx, src/client/state/sessionMachine.ts, FINDINGS.md]
iterations: 0
test_files: []
branch: ""
---

## Observed

The operator set EN→YUE in Live on the Realtime arm and **it output Cantonese**, contradicting three
artifacts in this repo that say it cannot.

## Finding 1 — the 13-language constraint is a DIFFERENT MODEL's

The "13 output languages" figure is real, but it belongs to **`gpt-realtime-translate`** — OpenAI's
purpose-built translation model, configured by setting an input and output **language code** on the
socket (the cookbook's example sets `"es"`). Its documented output set is: English, Spanish,
Portuguese, French, German, Italian, Russian, **Chinese**, Japanese, Korean, Hindi, Indonesian,
Vietnamese. "Chinese" is undifferentiated in the docs; **Cantonese/Yue is not separately listed**,
and no source found says whether it is included or excluded.

**This project does not use that model.** `REALTIME_MODEL = 'gpt-realtime'` (`src/core/arms.ts:84`),
and all 11 stored realtime runs carry `modelSnapshots.realtime: 'gpt-realtime'`.

`gpt-realtime` is the general speech-to-speech **assistant** model — the one you use when the app
"answers questions, calls tools, and manages a conversation". It is steered by a free-text
`instructions` field, **not by a language enum**. It has no documented output-language allow-list to
violate. Asking it to *"Translate everything the user says into Cantonese"* is an instruction, and it
follows instructions.

So the operator's assumption — that a documented 13-language list bounded what the model could speak
— was applying a real constraint from a model this repo never instantiates.

## Finding 2 — the claim predates the fix that made the experiment possible

| date | artifact |
|---|---|
| 2026-08-05 | `supportPill` declares EN↔YUE **"cascade only"** (`sessionMachine.ts:528`) |
| 2026-08-06 | Coverage card records *"English → Cantonese on Realtime returned Mandarin, not Cantonese, on every attempt"* (`ResultsView.tsx:242`) |
| **2026-08-09** | **Ticket 062 lands** — the selected pair finally reaches the wire |

Before 062, `realtime.ts` built its instruction as:

```js
const targetLanguage = this.config?.targetLanguage ?? '';
`Translate everything the user says into ${targetLanguage}. `
```

Replay never sent a language and Live never re-sent one on a pair switch, so `targetLanguage` was the
empty string and the model received:

> *"Translate everything the user says into . Speak only the translation — no commentary."*

**The model was never asked for Cantonese.** It was asked to translate into nothing and chose
something — German on stored run `dbeb6d94`, and evidently a Chinese variety when the operator tested
the Cantonese pair. Chinese is an unremarkable guess for a model given no target after hearing
English.

**"Realtime cannot do Cantonese" was almost certainly an artifact of ticket 062's bug, observed
under conditions where the experiment was never actually run.** This is the same failure class as
ticket 060's fabricated commit hashes: a confident claim whose evidence does not support it.

## Finding 3 — the restriction was never enforced, only asserted

`supportPill` (`sessionMachine.ts:528`) is a **label**, rendered at `LiveView.tsx:763` beside a
warning banner at `:1047`. Nothing in the transport, the session machine or the runner ever refused a
realtime + Cantonese session. The operator hit no bug reaching this state — the app always permitted
it, and now that the instruction is correct it works.

## What is now stale — all three assert something observation contradicts

1. **`ResultsView.tsx:242`** — the coverage card's observation naming Mandarin "on every attempt",
   and its `WRONG_VARIETY` / `NOT_REACHED` cells for the Realtime × Cantonese rows.
2. **`sessionMachine.ts:528`** — `supportPill` returning `'cascade only'` for `langIdx === 1`, and the
   `targetCantoOnRealtime` warning that rides on it.
3. **`FINDINGS.md`** — states the Mandarin trap is *"the single most consequential unknown… nobody
   has listened yet"* and that EN→YUE on Realtime *"has no mechanism at any price"*. The coverage
   citation module (ticket 060) carries the same claim with `commit: null`.

## Acceptance criteria — do NOT write until the listen is confirmed

- [ ] **The operator confirms by ear** that the output is Cantonese and not Mandarin. This is the
      whole original finding and it is audible-only; a transcript in Chinese characters reads the
      same either way, which is exactly PRD §10's trap. **Do not correct one unverified claim with
      another.**
- [ ] Once confirmed: the coverage card's Realtime × EN→YUE cell states what was actually observed,
      with the observation note rewritten to say the earlier result was produced by an instruction
      naming no target language
- [ ] `supportPill` stops asserting `'cascade only'` for a pair now demonstrated on both arms, or the
      label is re-scoped to what it can defend
- [ ] `FINDINGS.md`'s controllability and recommendation sections are corrected — the EN→YUE line
      currently reads as a vendor limitation and is at minimum unproven
- [ ] The reverse direction (YUE→EN on Realtime, `inputCantoOnRealtime`) is checked separately — it
      is a different claim with its own warning and was never tested either
- [ ] **Quality is a separate claim from capability.** "It emits Cantonese" and "its Cantonese is
      adequate for a clinical interpretation" are different findings. Do not let the second ride in
      on the first.

## Out of scope

- Switching Arm A to `gpt-realtime-translate`. Worth noting as a genuine architectural observation —
  a purpose-built translation model with pace-matching and source-voice preservation may be a better
  Arm A for this task than a general assistant model — but changing the arm mid-experiment
  invalidates every stored comparison. It belongs in the write-up as future work, not in the sweep.
- Re-running sweeps or re-recording. The corpus is fine.

## Why this is a better finding than the one it replaces

"Voice-to-voice cannot do Cantonese" is a vendor limitation nobody controls and nobody learns from.
**"Our own plumbing bug made a supported language pair look unsupported for four days, and three
artifacts repeated the claim until an operator happened to try it"** is a sharper illustration of
this project's actual thesis — that a wrong number, or a wrong claim, is worse than a missing one.
It also demonstrates the auditability argument from the other side: the failure was only findable
because the instruction on the wire was recoverable and datable.

## Sources

- OpenAI cookbook, *Build Live Translation Apps with gpt-realtime-translate* —
  https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide
- OpenAI API docs, *Realtime translation* —
  https://developers.openai.com/api/docs/guides/realtime-translation
- Microsoft Foundry, *GPT Realtime Translate overview* —
  https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/gpt-realtime-translate
