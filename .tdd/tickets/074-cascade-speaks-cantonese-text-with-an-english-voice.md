---
id: 074
title: "The cascade produces correct Cantonese TEXT and reads it with an English voice — PRD §10's trap is in Arm B/C, not Realtime"
status: pending
source: operator (2026-08-10) — "make sure we are outputting to Cantonese specifically"
depends_on: [062, 073]
touches: [src/server/providers/elevenlabs-tts.ts, src/server/providers/openai-tts.ts, src/core/models.ts, src/server/ws.ts, src/client/state/sessionMachine.ts, src/client/views/ResultsView.tsx]
iterations: 0
test_files: []
branch: ""
---

## Part 1 — the cascade's EN→YUE output is not steered to Cantonese

Traced end to end. Two of three stages are correct; the third is unaddressed.

| stage | gets | status |
|---|---|---|
| STT | `languageCode: 'en'` from `direction` | ✅ ticket 069 |
| MT | `targetLanguage: 'Cantonese'` from `pairs[1].tgt` | ✅ ticket 062 — produces Cantonese **text** |
| **TTS** | **nothing** | ❌ |

`openai-tts` sends `voice: this.config.voice ?? 'alloy'` and **no language parameter**.
`elevenlabs-tts` sends `voiceId ?? '21m00Tcm4TlvDq8ikWAM'` — an English voice — and the string
`language_code` **does not appear in the file at all**.

And `voiceId` / `voice` are **never configured anywhere in production**: `resolveTriple` builds every
provider from `{ model }`, so both TTS adapters always run their default English voice.

**So the cascade hands correct Cantonese characters to an English voice with no language steering.
That is exactly PRD §10's Mandarin-pronunciation trap — a transcript that reads perfectly and audio
that is wrong — and it lives in Arm B and Arm C.**

The project spent four days attributing that trap to Realtime (wrongly — see ticket 073) while the
actual mechanism sat unaddressed in the cascade.

### The structural part — `language_code` cannot express Cantonese

ElevenLabs' `language_code` is documented as **ISO 639-1**, and *"if the model does not support the
provided language code, it will be ignored."* **ISO 639-1 has no code for Cantonese.** Cantonese is
`yue` in ISO 639-3; ISO 639-1's `zh` is the Chinese macrolanguage and conventionally resolves to
Mandarin.

So adding `language_code` **cannot** fix this, and passing `zh` would actively request the wrong
variety. **The only lever is voice selection** — a Cantonese voice id.

> Confidence note: the `language_code` format comes from ElevenLabs' *Models* documentation. Their
> websocket endpoint reference describes the parameter only as *"Any type"*, so this must be
> confirmed against a real call before anything is built on it.

### This is why the coverage card's own onboarding note said what it said

The card cites *"one voice id per direction"* as the EN→Cantonese cascade cost. That work was
**described but never done** — `voiceId` is unset everywhere.

## Part 2 — the "cascade only" pill

`supportPill` (`sessionMachine.ts:528`) returns `'cascade only'` for `langIdx === 1`. Per ticket 073
that claim is stale: the constraint it encodes belonged to `gpt-realtime-translate`'s 13-language
list, not to `gpt-realtime`, which this project actually uses and which takes a free-text
`instructions` field with no output-language enum. The operator has now run EN→YUE on Realtime and
observed Cantonese output.

## Acceptance criteria

**Part 2 — the pill (do this first; it is small and unblocked)**

- [ ] `supportPill` no longer asserts `'cascade only'` for the Cantonese pair. Either both pairs read
      `'both modes'`, or the label is re-scoped to something it can defend.
- [ ] The `targetCantoOnRealtime` warning is removed or rewritten — it currently tells the operator a
      supported configuration is unsupported.
- [ ] `inputCantoOnRealtime` (**YUE→EN**, the reverse direction) is decided **separately and
      explicitly**. It is a different claim, it was never tested either, and it must not be silently
      swept along with the forward direction.
- [ ] The coverage card's Realtime × EN→Cantonese cell and its Mandarin observation stop asserting a
      result produced by an instruction that named no target language (see ticket 073's timeline).
- [ ] `FINDINGS.md` is corrected where it states EN→YUE on Realtime *"has no mechanism at any price"*.

**Part 1 — the TTS (needs an operator decision before it can be built)**

- [ ] A **Cantonese voice id** is selected for the EN→YUE direction and reaches
      `elevenlabs-tts` / `openai-tts` through `resolveTriple`, the same route `targetLanguage` (062)
      and `languageCode` (069) already take. **The voice id is the lever, not `language_code`.**
- [ ] A direction with no configured voice keeps today's default and does **not** silently
      substitute one — an unconfigured voice is a known gap, not a guess.
- [ ] Falsifiable on the wire, per direction: the voice id in the ElevenLabs URL for `en→yue` differs
      from the one for `en→es`.
- [ ] **`zh` is never sent as a Cantonese language code.** Requesting the wrong variety is worse than
      requesting none, and it would be this project's characteristic sin in a new place.

## Out of scope

- Re-running sweeps; the corpus is fine.
- Switching Arm A to `gpt-realtime-translate` (noted in ticket 073 as future work — changing an arm
  mid-experiment invalidates every stored comparison).
- Whether the Cantonese *quality* is clinically adequate. Capability and quality are different
  claims; this ticket only makes the pipeline ask for the right thing.

## Notes — what the operator must supply for Part 1

A **Cantonese voice id** from their ElevenLabs voice library. Voice ids are account- and
library-specific, so this cannot be chosen from the repo. Until it exists, Part 1 cannot be
implemented honestly — and shipping `language_code: 'zh'` as a stand-in would request Mandarin,
which is the defect, not the fix.

---

## CORRECTION (2026-08-10) — supersedes Part 1's diagnosis above

Two corrections from the operator, who is a native Cantonese speaker, plus two vendor facts I
verified afterwards. **Read this instead of Part 1's "written Cantonese" framing.**

### 1. The written-form framing was wrong

I proposed distinguishing "written Cantonese" from "standard written Chinese" at the MT stage.
The operator's correction: **the characters are shared.** For anything clinical the text is standard
characters either way, and Mandarin and Cantonese speakers read *the same characters* with different
pronunciation — 你好 is *nǐ hǎo* or *néih hóu* depending on the reader.

So this was never a text-form problem. **It is a pronunciation-selection problem at the TTS**, and
the MT prompt needs no change.

### 2. There is no Chinese voice in the account, and it would not matter

Queried the operator's ElevenLabs library: **32 voices, all English, Hindi or Spanish.** No `zh`.

It is moot regardless — `eleven_flash_v2_5` is multilingual, so the **model** decides pronunciation
from the text and the **voice** supplies only timbre. Swapping voice ids changes how it sounds, not
what language it speaks.

### 3. THE FINDING — the two TTS vendors differ structurally, and only one can do this

| | mechanism | Cantonese |
|---|---|---|
| **Arm B — `gpt-4o-mini-tts`** | natural-language **`instructions`** field, documented to steer *accent*, intonation, tone | **reachable** — it can be told to read the characters with Cantonese pronunciation |
| **Arm C — `eleven_flash_v2_5`** | fixed language list: v2's 29 languages **+ Hungarian, Norwegian, Vietnamese** | **NOT reachable at any price** — "Chinese" means Mandarin; Cantonese is absent, and ISO 639-1 has no code for it either |

**This is the best result Experiment 2 could have produced.** Its question is *"what does swapping
providers buy?"* — and the answer is not a latency delta. It is that one vendor's steerability
reaches a language the other cannot reach **at all**, which is exactly PRD §7's *provider
flexibility* Key Impact Metric with evidence rather than assertion.

It also gives the coverage card an honest EN→Cantonese cascade row for the first time: **reached on
Arm B, not reached on Arm C** — replacing a claim that was never true of either.

### Revised acceptance criteria for Part 1

- [ ] `openai-tts` accepts a pronunciation instruction and sends it as the API's `instructions`
      field, routed through `resolveTriple` exactly as `targetLanguage` (062) and `languageCode`
      (069) already are
- [ ] For `en→yue` the instruction names Cantonese pronunciation explicitly; for `en→es` and any
      direction with no special requirement **no `instructions` field is sent at all** — absent, never
      a guessed default
- [ ] Falsifiable on the wire, per direction: the `instructions` value for `en→yue` differs from
      `en→es`, and `en→es` sends none
- [ ] **`elevenlabs-tts` is NOT given a Cantonese `language_code`.** ISO 639-1 cannot express it and
      `zh` would request Mandarin — the defect, shipped as the fix. Arm C's inability is a **finding
      to report**, not a gap to paper over.
- [ ] The coverage card records Arm B reached / Arm C not reached for EN→Cantonese on cascade, and
      `FINDINGS.md` carries the vendor asymmetry as Experiment 2's real result
