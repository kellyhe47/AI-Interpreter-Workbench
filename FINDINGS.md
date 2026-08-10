# FINDINGS — three interpreter architectures, compared

There are two ways to build a live speech interpreter. One is a single model that listens in one
language and speaks in another — a sealed box. The other is an assembly line: one service turns
speech into text, another translates it, a third speaks it. The sealed box is simpler; the assembly
line lets you swap any part. This workbench runs both on identical input.

| Arm | Recipe |
|---|---|
| **A** | **Realtime** — the sealed box. OpenAI's voice-to-voice model does everything internally. We can only time the whole thing. |
| **B** | **Cascade, all-OpenAI** — the assembly line built entirely from OpenAI parts. A and B share a vendor, so any difference between them is caused by the design, not the company. |
| **C** | **Cascade, one part swapped** — identical to B except the voice stage, which uses ElevenLabs. Exactly one difference, so whatever changes between B and C is caused by that one swap. |

Arm membership is *derived* from what was configured, never declared. Deviate anywhere and the run
is tagged ad-hoc and never counted as evidence.

> **Reading rule for this document.** The export bundle (`npm run export-results` →
> `results/<date>/`) **has never been run**, so no figure here can carry a bundle citation. Every
> figure is therefore one of exactly two things: (a) a verified measurement inside a
> **`MEASURED TODAY — PRE-EXPORT`** block that names the file it was computed from, or (b) the
> literal `not yet measured`, followed on the same line by the specific run that would fill it.
> A pre-export figure is **not** bundle-cited evidence and must not be read as one.

---

## 1. Latency

### What is measured

> **MEASURED TODAY — PRE-EXPORT.** Source: `data/live-sessions.jsonl`, 8 stored Live sessions.
> Recomputed twice today from the stored per-utterance timings, replicating `anchoredLatencyMs` and
> nearest-rank percentiles — once by the author, once independently by a reviewer. The two
> recomputations agree exactly. **This predates any `results/<date>/` bundle and is not cited from
> one.**
>
> | Column | Sessions | n | p50 | p95 |
> |---|---|---|---|---|
> | `realtime · default` | 1 | 7 | **260 ms** | 512 ms |
> | `realtime · trimmed` | 2 | 8 | **423 ms** | 449 ms |
> | `cascade` | 5 | 16 | **1487 ms** | 2858 ms |

Two riders, both load-bearing:

- **Until today the two Realtime policies were pooled into one column reading 399 ms.** That column
  was labelled `default` but actually contained all Realtime policies — *a wrong number, not a
  missing one*, which is the worse of the two failures. Split above; ticket 064. The p95 is
  **unchanged** by the split (512 ms either way), because the pooled p95 happened to land on the
  default session's own tail.
- **Cascade partially meets the rubric bar.** Against *"under 3s, target under 2s"*: 1487 ms at p50
  is under 3s and under 2s; 2858 ms at p95 is under 3s but **not** under 2s. Cascade is not
  unmeasured, and it is not a clean pass either.

These are Live sessions — different unstored speech in each — so they are compared on shape, never
against Replay Runs, and never pooled with them.

### What is not

- Replay p50/p95 per arm, per language pair: `not yet measured` — filled by a 3-repetition batch
  sweep over the 3 EN Recordings × Arms A/B/C, then `npm run export-results`.
- The stage-level breakdown (endpointing · STT · MT · TTS · queue): `not yet measured` — filled by
  the same sweep; the intervals are already computed per utterance in `src/core/timing.ts` and need
  only runs to compute over.
- Arm A vs Arm B on identical input — *the headline experiment*: `not yet measured` — filled by the
  same sweep; it is the Exp-1 card's own empty state today.
- Latency drift across a long conversation: `not yet measured` — filled by one 5-minute Live session
  per arm, the rubric's stability benchmark, which has never once been executed.

---

## 2. Quality

- **WER, EN↔ES, per arm:** `not yet measured` — filled by a sweep over the 12 categorised corpus
  utterances (each carries verbatim reference text) followed by `npm run export-results`.
- **Blind adequacy/fluency scores:** `not yet measured` — filled by running `Compare blind` over two
  completed Runs of the same Recording; **no pair has ever been scored**, so WER and the quality
  scores both have zero samples behind them.
- **Realtime WER is a sidecar measurement, by construction.** Realtime emits no source transcript as
  a byproduct; showing source text forces a *separate* STT model in parallel. That transcript is a
  second model's guess about the audio, not what the model translated from. The two can disagree.
  This is a permanent property of Arm A, not a gap in this run.

### The Cantonese case, and why a text-only evaluation would score it as a pass

Cantonese and Mandarin **share their written characters**, pronounced differently. So a TTS given no
delivery instruction reads correct Cantonese text aloud **in Mandarin**: a transcript that reads perfectly and audio that is wrong. **A text-only evaluation
scores this as a success.** It is audible only, and only to a speaker — hence playback-only blind
scoring. It is also a **pronunciation choice at the TTS**, which is where the two cascade TTS
vendors stop being interchangeable (§4.3). Clinical *adequacy* stays **`not yet measured`**.

Realtime was long recorded here as unable to produce Cantonese. Wrong twice over: the
13-output-language list belongs to `gpt-realtime-translate`, not the `gpt-realtime` this project
runs, and the runs behind the claim predate ticket 062, i.e. any target language on the wire. The
operator has since run EN→YUE on Realtime and heard Cantonese, and YUE→EN — Cantonese spoken in,
English back. **Both directions are reached on Realtime by observation**; neither is scored.

### Corpus

3 EN Recordings, 12 utterances, every one categorised with verbatim reference text,
`origin: 'corpus'`, `corpusVersion: 'corpus-v1'` — recorded through the app's own record flow. The
36 synthetic tone-burst clips that used to sit in `corpus/` were **deleted** (ticket 054); their own
generator header called them *"a tone burst + silence tail… NOT speech."* The real artifacts are
`corpus/SCRIPTS.md` and `corpus/LIVE-SCRIPT.md`, the scripts the takes were read from.

---

## 3. Cost

### The honest state today

- **Arm A (Realtime) is the only arm metered end to end.** `priceRealtimeUsage`
  (`src/core/pricing.ts:418`) turns the provider's reported token usage into a total.
- **Arms B and C both report `not measured`.** `priceCascade` (`src/core/pricing.ts:515-533`)
  refuses a total when *any* stage is unmeasured, and two stages are: MT reports no token usage at
  all, and `gpt-4o-mini-tts` bills audio-out tokens its API never returns. The reason is shared, so
  the intuitive story — "the cross-vendor arm is the unmeasured one" — is backwards.
- **Arm C's per-character figures additionally carry `verified: false`**: the ElevenLabs
  1,000-character-per-request minimum is an unverified assumption, and no ElevenLabs cost may be
  reported until aggregate-vs-per-chunk billing is confirmed.
- Unmeasured is stored as `null` and renders as the literal `not measured`
  (`COST_NOT_MEASURED_CELL`, `src/core/pricing.ts:49`). It is **never** rendered as a zero. A zero
  would be a claim; `not measured` is the truth.

Consequently: **cost per minute per arm** is `not yet measured` — filled by a sweep plus
`npm run export-results`, and for Arms B and C additionally by ticket 053 (the provider usage
channel), without which no total can exist regardless of how many runs are executed. **The cost
slope over conversation length** — whether the sealed box's per-minute cost climbs as it re-reads
history while the assembly line stays flat — is `not yet measured`, filled by one 5-minute Live
session per arm, with the `trimmed` policy as the control that separates billing from
voice-to-voice itself.

### Onboarding cost for a new language pair — real commits, not an estimate

Two commits, verified against git history on every run by `npm run verify-citations`:

| Commit | Insertions | What it bought |
|---|---|---|
| `a6ca500` | **+694** | The Replay target-language control. Before it, no screen could ask for Cantonese — the pair was unreachable whatever the providers supported. |
| `a57cd3a` | **+657** | Carried the chosen pair through both arms and both paths. |

**1351 insertions for the first additional language pair**, because the plumbing did not exist. The
*next* pair is one entry in `pairs` (`src/client/state/sessionMachine.ts`). **The shape of that curve
is the finding, not a single cheap number** — a one-line marginal cost quoted without the 1351 in
front of it would be a lie about what onboarding actually costs.

(An earlier version of this claim in the app asserted "one language constant, +11 lines" and cited
two commits that do not exist. It has been deleted — a commit hash that fails `git cat-file -t` is a
fabrication, not a rounding error.)

---

## 4. Controllability

This is the one dimension written in full today, because it is reasoned from architecture rather
than measured. Four findings.

**1 · The 5-vs-3 observable-interval asymmetry.** The cascade exposes **five** stage timings —
endpointing, STT, MT, TTS, queue — which sum exactly to end-to-end. Realtime exposes **three**:
endpointing, `model`, queue, with the big middle one marked *opaque* — the sealed box. When
something breaks, the cascade names the failed stage; Realtime cannot. Its error events carry
`opaque: true` precisely because no stage attribution is possible
(`src/client/transport/types.ts:23-24`). That difference is itself a finding, and it holds before a
single measurement exists.

**2 · Auditability, and its compliance consequence.** The cascade's transcript **is** what got
translated — it is the literal input to the MT stage — so a wrong output is traceable to the stage
that produced it. Realtime's transcript is a *second model's* guess at what the first one said; the
two can disagree, and when they do, the record of the encounter does not describe what the system
actually did. **For medical and legal interpretation this is a compliance and liability question,
not a technical footnote.** If a patient was mistranslated, the cascade can show which stage
mistranslated them and the record is the evidence; with Realtime, the record is a plausible
reconstruction, and "the transcript looked correct" is exactly the failure mode §2's Cantonese case
describes.

**3 · Provider swapping is a contained change.** Arm C differs from Arm B in **exactly one stage**
(TTS: `gpt-4o-mini-tts` → `eleven_flash_v2_5`). Nothing else in the recipe moves, which is what
makes any B→C delta cleanly attributable to the swap. That containment is the assembly line's actual
product: the sealed box has no seam to swap at, so a vendor-level problem with Realtime is a
migration, not a configuration change. Two cautions: this proves a **TTS** swap only, not "swapping
any provider" — STT and MT provider variation is untested — and **flexibility is not coverage**.

**And the swap's real payoff is language reach, not a latency delta.** `gpt-4o-mini-tts` takes a
free-text `instructions` field documented to steer accent and tone, so Arm B can be told to read the
shared characters with Cantonese pronunciation. `eleven_flash_v2_5` lists no Cantonese, and
ElevenLabs' `language_code` is ISO 639-1, which has no code for it (`zh` is the macrolanguage, i.e.
Mandarin — sending it requests the wrong variety). **Arm C cannot reach this language at any price;
Arm B can, through a swap touching one stage** — provider flexibility with evidence, not assertion.

**4 · Cost metering is asymmetric, and that is a controllability finding.** One provider tells you
what you spent and the others do not. Arm A returns usage you can price; Arms B and C do not, so the
architecture with more knobs is currently the one you can least account for financially. This is not
only a measurement gap in this project — an operator choosing the cascade inherits the job of
reconciling three vendors' billing, and today two of the three stages report nothing usable.

---

## 5. Recommendation — which mode fits which scenario

Not a winner. Four scenarios, each with what the recommendation rests on and what it lacks.

**Conversational latency is the product, and the language pair is well supported → Arm A
(Realtime).** Rests on: the pre-export Live figures above (260 ms / 423 ms p50 against cascade's
1487 ms) — a gap large enough that no plausible measurement error closes it. Lacks: any Replay
head-to-head on identical input, and any 5-minute stability run. The Live numbers come from
different speech in each session and are compared on shape.

**Medical, legal, or any setting where the record must be defensible → the cascade (Arm B or C).**
Rests entirely on architecture (§4.1, §4.2), which is why it is the recommendation this document can
make most confidently: the transcript is the translation's actual input, and a failure names its
stage. Lacks: nothing measurable — this argument does not become truer with more runs. Accept the
latency cost knowingly; at p95 it is 2858 ms, which is not the sub-2s target.

**An uncommon language pair, or a vendor you may need to leave → the cascade.** Rests on: the
one-stage containment of the B→C swap, on onboarding costing 1351 insertions once and one `pairs`
entry thereafter, and on §4.3's asymmetry: the swap seam is what lets EN→Cantonese be reached on Arm
B when Arm C cannot reach it. Lacks: scored evidence of Cantonese *quality*. Reach is not adequacy.

**Cost predictability → no recommendation is available.** This is the uncomfortable one. The
theoretical story favours the cascade (flat per-minute cost against a sealed box that re-reads
history), but the only arm that can currently tell you what it spent is the sealed box. Filling this
needs a sweep, the 5-minute Live sessions, and ticket 053. Until then, anyone quoting a per-minute
figure for Arm B or C is quoting nothing.

**The most consequential remaining unknown** is not on this list: whether the Cantonese any arm
produces is *good enough to interpret with*. Capability holds on Arms A and B; adequacy is unheard.

---

## Limitations

- **N is what actually completed, never what was intended.** 8 Live sessions (7 + 8 + 16 utterances
  across the three columns above); 3 stored Runs, of which one failed and all three are
  `origin: 'manual'` and therefore ineligible for aggregation. **Zero aggregate-eligible Runs.**
- **Single evaluator.** One native Cantonese speaker (the author). No Spanish evaluator has scored
  anything. n=1 judge per language at best, n=0 for Spanish.
- **One operator.** Every recording, run and session in this repo was produced by one person on one
  machine, in one region, on one instance. No scale, jitter, or multi-region data exists.
- **Language pairs covered:** EN only, as input. 3 EN Recordings, 12 utterances.
- **Language pairs NOT covered:** ES takes 1–3 — blocked on a Spanish-speaking coworker, the only
  externally-blocked item in the project. YUE takes 1–3 — not blocked on anyone, simply not recorded.
- **Never executed:** one 5-minute Live session per arm (the rubric's stability benchmark); any
  listening pass over EN→YUE output audio; any blind-compare scoring. Each is operator time, not code.
- **Every stored record predates the code that would have populated it.** No record carries
  `pricingVersion`; all 8 Live sessions store `p50: null` at rest (the figures above are recomputed
  from per-utterance timings); 2 of 3 Runs render every stage as `—`. Re-running is worth more than
  any further code change.
- **Read speech is cleaner than natural speech**, so any future WER from this corpus is
  optimistically biased, and at ~150 reference words per direction it is directional, not precise.
- **Transport differs between arms** (WebRTC vs WebSocket) — measured separately, never subtracted.
- **A stated gap is a finding; a silent one is a hole.** Everything above marked `not yet measured`
  is measurable with the code that already exists and an operator's time. Nothing here is blocked on
  a design decision.
