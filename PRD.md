# AI Interpreter Workbench — PRD

**Realtime API vs. Cascade Pipeline**

> **Scope contract (AMENDED 2026-08-09).** The original contract read *"everything in this document
> will be built; nothing here is aspirational."* Against a brief that allots **3–4 days / 15–20
> hours**, that promise is what kept the backlog regenerating faster than it drained — 048 spawned
> 050; 051 spawned 052 spawned 053. It is hereby narrowed.
>
> **The contract now: everything in §16 Deliverables will be built. §15A names what is cut, and §15B
> what is deferred, each with a reason.** A cut item is not a debt and does not return as a ticket.
> Items considered and rejected during design remain in **§17**.
>
> **The rubric is the grading contract; this document is the method.** Where they disagree, the
> rubric wins and the disagreement is recorded rather than resolved by building both.

---

## 1. Problem

Boostlingo needs a defensible position on two architectures for live interpretation:

- **Direct voice-to-voice** — a single vertically-integrated model (OpenAI Realtime API)
- **Composable cascade** — STT → Translation → TTS, assembled from independent providers

The tradeoffs on latency, quality, cost, and operational control are not knowable from documentation. This project builds both, instruments both, measures both under controlled conditions, and produces a recommendation grounded in data.

**The deliverable is not two working demos. It is a defensible opinion, backed by reproducible measurement.**

---

## 2. Goals & Non-Goals

### Goals
1. Both architectures fully working in one browser SPA — **Live** for real interpretation, switchable mid-conversation, and **Replay** for reproducible measurement against saved recordings
2. Reproducible measurement whose numbers survive scrutiny, produced by the app itself rather than a separate harness
3. Quantified comparison: latency (p50/p95), cost/min, quality, provider flexibility, language-pair onboarding cost
4. A 1–2 page write-up with a scenario-based recommendation

### Non-Goals
- Production-grade scale, auth, multi-tenancy, or a hosted database. **Local persistence of Recordings and Runs is in scope** (§7) — it is what makes the workbench a workbench.
- Beating either architecture's published benchmarks
- Exhaustive language coverage
- Automatic provider failover (considered and cut — §17)

---

## 3. Experimental Design

The central risk in this project is producing numbers that confound **architecture** with **vendor**. Two separate experiments with different controls:

### Experiment 1 — Does architecture itself cost latency?
**Vendor held constant. Only the architecture varies.**

| Arm | Description |
|---|---|
| **A** | OpenAI Realtime (`gpt-realtime`), voice in → voice out |
| **B** | OpenAI cascade: `gpt-4o-transcribe` → `gpt-4o-mini` → `gpt-4o-mini-tts` |

Same vendor, same model family, same datacenter, same network path, same VAD setting. The measured delta is attributable to architecture. **This is the headline result.**

### Experiment 2 — What does cascade's controllability buy?
**Architecture held constant. Only providers vary.**

| Arm | Description |
|---|---|
| **B** | OpenAI cascade (baseline, from Exp 1) |
| **C** | `gpt-4o-transcribe` → `gpt-4o-mini` → **ElevenLabs Flash v2.5 TTS** |

**Exactly one stage differs between B and C — TTS.** An earlier draft swapped STT *and* TTS simultaneously while claiming to isolate provider choice; that delta would have been unattributable to either stage. One variable, clean attribution.

TTS is the right stage to swap: it carries the largest latency lever (ElevenLabs Flash accepts **streaming text input**, `gpt-4o-mini-tts` does not), the most audible quality difference, and it is the only real provider that exercises the `AsyncIterable<string>` interface decision in §6.

Answers the "provider flexibility" and "time-to-onboard" metrics, which are structurally unmeasurable in Arm A.

**The measured arms span two vendors — OpenAI and ElevenLabs.** A third STT vendor was considered and cut (§17, 17a). Anthropic is available in the selectable menu as the cross-vendor MT option but is never part of a named arm, because Exp 2's variable is TTS. Multi-vendor composition is demonstrated either way; the point of Exp 2 was never vendor count but attributable delta.

### Track 3 — Cantonese: an exploratory case study, not an experiment
Coverage, pronunciation, transcript auditability, and failure mode on an uncommon pair. Qualitative, single native evaluator, no verified written reference. See §11.

### Non-pooling rule

**Statistics from the three tracks are never combined, and no track is presented as evidence for another.** Each keeps its own controls, its own N, and its own provenance line. A Cantonese observation cannot support a claim about EN↔ES latency; a provider-swap delta cannot support a claim about architecture.

**Reporting hierarchy — fixed, in this order:**
1. Controlled EN↔ES architecture baseline (Exp 1) — the headline
2. Provider-swap controllability experiment (Exp 2)
3. Cantonese case study — coverage and pronunciation findings, explicitly labelled exploratory

Anything that would require mixing tracks is stated as a hypothesis, not a result.

---

## 4. Stack & Transport

### Stack
**Node.js + TypeScript, full stack.** This is fundamentally a real-time audio/WebSocket orchestration problem — Node's event loop and streaming ecosystem are the best-trodden path, most Realtime API reference implementations are TS, and one language across front and back removes context-switching cost. (Rubric prefers .NET/C# but explicitly permits candidate's choice with justification.)

### Realtime transport — browser ↔ OpenAI, direct WebRTC
The backend mints a short-lived ephemeral session token over HTTPS; **audio never touches our server.** This is OpenAI's recommended browser pattern and the lowest-latency path. Inserting a relay would directly fight the <1.5s benchmark.

### Cascade transport — browser ↔ our server, WebSocket
- Binary frames, **PCM16 mono**
- **24 kHz up and down.** 16 kHz was the original spec; preflight found OpenAI's transcription session **rejects anything below 24000** (`integer_below_min_value … Expected >= 24000`). 24 kHz PCM16 end to end, verified live. Minor bandwidth cost, no resampling anywhere in the measured path.
- 20 ms chunks
- No Opus encode/decode — raw PCM avoids codec latency; all target STT providers accept linear16 natively

**WebRTC-to-server was rejected on the merits, not difficulty.** WebRTC ingest requires a jitter buffer (deliberately buffering 40–100 ms to smooth packet arrival) plus Opus transcode, which on a stable connection should measure *slower* than raw WebSocket PCM.

**This is stated as a hypothesis, not a premise.** It is a reasoned expectation, not a measured result, and the write-up says so. The transport hop is instrumented separately (§8), so the actual cost of our ingest path is reported as a number rather than asserted. We do not claim WebSocket PCM is categorically faster than WebRTC — only that we measured ours.

**Disclosed consequence:** the two arms use different transports. This is measured (§8) and stated in the write-up, along with the observation that production cascade over consumer networks *would* need WebRTC ingest — a cost the Realtime path absorbs invisibly inside OpenAI's own transport.

---

## 5. Providers

**Three vendors — OpenAI, ElevenLabs, Anthropic. Six real adapters plus three fixtures.**

The named experimental arms use only two of those vendors; Anthropic appears solely as the cross-vendor MT option in the selectable menu (§6), never inside a measured arm.

| Stage | Arm B (control) | Arm C (best-of-breed) | Test |
|---|---|---|---|
| **STT** | `gpt-4o-transcribe` | *(same — held constant)* | Fixture |
| **MT** | `gpt-4o-mini` | *(same — held constant)* | Fixture (non-streaming) |
| **TTS** | `gpt-4o-mini-tts` | **ElevenLabs Flash v2.5** | Fixture |

ElevenLabs Flash v2.5 is chosen for its **WebSocket streaming text input** — translated text is pushed as it is produced rather than after the full translation completes. This is the single largest lever on cascade latency and it dictates the TTS interface shape (§6).

### Published rates (verify at build time; cost model computes from metered usage)
| Item | Rate |
|---|---|
| `gpt-realtime` | $32/M audio-in, $64/M audio-out tokens |
| `gpt-realtime-mini` | $10/M in, $20/M out — **used for development** |
| `gpt-4o-transcribe` | ~$0.006/min |
| `gpt-4o-mini` | $0.15/M in, $0.60/M out |
| `gpt-4o-mini-tts` | $12/M audio-out tokens |
| `gpt-realtime-2.1` | current snapshot; `gpt-realtime` / `gpt-realtime-mini` confirmed as working aliases |
| ElevenLabs Flash v2.5 | $0.05 / 1k chars |

### Cost is a curve, not a constant

`gpt-realtime` is token-billed with conversation replay, so cost per minute rises across a session. `gpt-realtime-translate` is billed by **audio duration at $0.034/min** — flat, regardless of length. Cascade is flat at ~$0.021/min with broader language reach.

The rubric requires `gpt-realtime`, so that is Arm A. `gpt-realtime-translate` is measured as a **cost and coverage datapoint**, not a fourth arm — one short run confirming the published rate and its language list. The slope itself is measured and reasoned about in §7.

**Known cost trap:** ElevenLabs bills a 1,000-character minimum per request. Because cascade streams text in chunks, aggregate-vs-per-chunk billing must be verified before any Arm C cost figure is reported.

---

## 6. Architecture

### Two levels of abstraction — kept distinct

**Mode level** — the UI drives exactly one transport at a time and cannot tell which it is:

```
audio source ─→ [Router] ──→ RealtimeTransport   (WebRTC → OpenAI)
  Live: mic         │
  Replay: clip @1×  └─→ CascadeTransport    (WebSocket → server)

interface InterpreterTransport {
  start() · stop() · sendAudio(pcm)
  events: onSourceText · onTargetText · onAudio · onStageTiming
}
```

**The router switches; it does not fan out.** An earlier design fanned the mic out to several arms at once so a live comparison shared identical input. The Replay flow makes that unnecessary — a saved Recording gives identical input across configurations with no concurrent-network contention — so fan-out was retired and the router went back to being a switch (§17, 19b).

Both Live and Replay feed the same transports; only the audio source differs. That is what lets one code path serve real interpretation and reproducible measurement.

**Stage level** — used by cascade only. Realtime has no stages; it is one sealed box.
### Stage interfaces — async generators

```ts
interface SttProvider {
  readonly name: string
  transcribe(
    audio: AsyncIterable<Int16Array>,
    opts: { language: string; signal: AbortSignal }
  ): AsyncIterable<SttEvent>          // { type: 'partial'|'final', text, tStart, tEnd }
}

interface TranslationProvider {
  readonly name: string
  readonly streaming: boolean          // reporting only, not control flow
  translate(
    text: string,
    opts: { from: string; to: string; signal: AbortSignal }
  ): AsyncIterable<string>
}

interface TtsProvider {
  readonly name: string
  synthesize(
    text: AsyncIterable<string>,       // streaming text input
    opts: { language: string; voice?: string; signal: AbortSignal }
  ): AsyncIterable<Int16Array>
}
```

**Design rules embedded above:**

1. **TTS accepts `AsyncIterable<string>`, not `string`.** The interface is shaped to the *most* capable provider; less capable ones concatenate internally. Typing it as `string` would have permanently forfeited ElevenLabs' streaming input to match the weakest vendor.
2. **Non-streaming providers yield once.** No second interface, no branching in consumer code.
3. **`AbortSignal` everywhere** — required for mid-session switching, timeouts, and clean teardown.
4. **Async generators over EventEmitters/Node streams** — automatic backpressure, normal `try/catch` error propagation, `for await` composition, and fixtures are just generators yielding on a timer.

### Cross-cutting concerns are decorators, not interface members

```ts
const tts = withTiming('tts', withRetry(withTimeout(new ElevenLabsTts(cfg), 5000)))
```

Instrumentation and resilience are implemented once and applied uniformly. Adapters stay thin — protocol translation only. A stage cannot be accidentally left uninstrumented.

### Swappable cascade providers — a capability, deliberately quarantined from the experiment

**The capability.** Every cascade stage is independently selectable **from the UI in both modes** — the Replay configuration panel is the primary surface, and Live exposes the same selector before a session starts. The active triple is always visible and is recorded on every Run and LiveSession. This is the rubric's *"providers can be swapped without rewriting the app"* requirement, demonstrated rather than asserted, and it is what makes "time-to-onboard" measurable.

**The selectable model menu — three options per stage, zero new vendor accounts:**

| Stage | Options | Vendor | Contrast it exposes |
|---|---|---|---|
| **STT** | `gpt-4o-transcribe` | OpenAI | baseline |
| | `gpt-4o-mini-transcribe` | OpenAI | same vendor, ~half the price — isolates model from vendor |
| | **ElevenLabs Scribe v2 Realtime** | ElevenLabs | cross-vendor; WebSocket, partial + committed transcripts, ~150 ms |
| **MT** | `gpt-4o-mini` | OpenAI | baseline, streaming |
| | **Claude Haiku 4.5** | Anthropic | cross-vendor, streaming |
| **TTS** | `gpt-4o-mini-tts` | OpenAI | baseline; no streaming text input |
| | **ElevenLabs Flash v2.5** | ElevenLabs | streaming text input — the largest latency lever |
| | **ElevenLabs Multilingual v2** | ElevenLabs | same vendor, slower and higher quality — isolates the speed/quality trade from the vendor choice |

STT and TTS each carry a same-vendor and a cross-vendor alternative; MT carries the cross-vendor one. *(§17, 19e, 23f.)*

All implementations of a stage pass **one shared contract suite** (§13). A provider is interchangeable if and only if it passes unmodified. A fixture exists for every stage but is **not offered in the selection menu** — fixtures are for development, CI, and fault injection, and a fixture-backed Run must never reach the ledger as though it were measured (§8).

**Selection is of a model, not a voice.** Where a provider exposes a voice, the voice is a **pinned constant** per vendor (§8 controlled-variable register), configured in code and recorded on the run — never a user choice. Voice materially moves fluency scores, so exposing it would make quality figures incomparable across runs.

**Default configuration** for a fresh panel is **Arm B's triple** — `gpt-4o-transcribe` → `gpt-4o-mini` → `gpt-4o-mini-tts`. It is the experimental baseline, so the default state produces comparable runs rather than orphans.

**The panel names the arm when the configuration matches one.** Because `armTag` is derived rather than declared, a user who assembles Arm B's exact triple is producing an Arm-B-tagged run whether or not they intended to. The panel displays the derived tag live — "this is Arm B" or "ad-hoc" — so membership is never a surprise discovered later in the ledger.

**The quarantine — membership is derived, never declared:**

1. **Named arms are frozen constants.** Arm A, B, and C are fixed configurations in code.
2. **`armTag` is computed from the run's actual configuration** — provider triple, context policy, model snapshots. If a run's configuration matches Arm B's definition exactly, it *is* an Arm B run. There is no arm-labelling control, so mislabelling is structurally impossible rather than merely discouraged.
3. **`origin: 'sweep' | 'manual'`** records how the run was triggered.
4. **Experiments aggregate runs where `armTag` matches AND `origin === 'sweep'`.**

`origin` matters because sweep runs had counterbalancing and warmup discard applied and a manual run with the identical triple did not — same configuration, different measurement conditions. *(§17, 22d–22e.)*

**Runtime switching is a demonstration and an onboarding measurement — never an experimental variable.** Exp 2 remains a single-stage swap between two frozen configurations (§3).

**No new vendor accounts are required.** Both second implementations come from keys already held: ElevenLabs covers STT *and* TTS, Anthropic covers MT. The **ElevenLabs key scope must be widened** — it is currently synthesis-only, and preflight found `user_read` and `speech_history_read` both 401. Add `speech_to_text` for the Scribe adapter and `user_read` to unblock the outstanding billing verification (§5). Same key, dashboard toggle.

Scribe v2 Realtime's **committed** transcript is the turn-final signal; its partials are not the trigger. The contract suite asserts this mapping (§13 test 6), the same as for OpenAI.

### Provider selection is config-driven

```ts
const stt = createStt(cfg.stt.provider, cfg.stt.options)
```

- Adding a **language pair** → config entry
- Adding a **provider** → one adapter file + one registry line

---

## 7. Product Flow & Storage

How the two modes work, what they persist, and the session states that support them.

### Two modes, three entities

| Entity | Is a… | Answers | Created in |
|---|---|---|---|
| **Recording** | an input | what audio was spoken | Replay |
| **Run** | an execution | what happened feeding that audio through one configuration | Replay |
| **LiveSession** | a session | how a real conversation went | Live |

A Recording is reusable input. A Run is one Recording × one configuration → metrics. A LiveSession has no stored input, so it can only ever be measured against itself.

### Live mode

1. Pick an architecture — Realtime, or Cascade with a model chosen per stage.
2. Start a session. Speak; interpreted audio plays back as soon as each utterance is ready.
3. **Maximum 5 minutes**, then the session ends.
4. Session metrics are saved as a `LiveSession`. **The audio is discarded.**

**Exactly one architecture per session.** The toggle switches mid-session; it never runs two at once. *(§17, 19g.)*

```
LiveSession {
  id, startedAt, endedAt, durationMs,
  architecture, providerTriple, modelSnapshots,
  utterances[]      // per-utterance timings + cost, for p50/p95 and drift
  latency: { p50, p95, driftMinute1ToEnd },
  cost: { totalUsd, perMinuteMinute1, perMinuteFinalMinute },
  stability: { utterancesCompleted, disconnects, heapStart, heapEnd },
  quality: { wer?, subjectiveNotes? }
}
```

There is no separate stability artifact. **Every Live session is a ≤5-minute measured session**, and the rubric's stability benchmark is simply the one you run for the full five minutes. Cost slope and latency drift come from the same `utterances[]` array.

**WER is not measured in Live.** WER needs a known reference transcript and free conversation has none. `quality.wer` is always null in a `LiveSession`; quality there is subjective notes only. **WER comes from Replay over the scripted corpus**, where a reference exists. Forcing a script into Live would cost the natural conversational speech that is the only thing Live measures better than Replay.

**Nothing from a LiveSession is compared against a Run.** Different inputs, no shared basis.

### Replay mode

1. Record a clip — **maximum 1 minute**. It is saved and appears in the UI.
2. Pick that clip, pick an architecture, and for Cascade pick a model per stage.
3. Trigger the run manually. **One architecture at a time.**
4. Repeat with whatever configurations you want to compare.
5. The results screen groups every Run under its Recording and compares them.

```
Recording { id, audio (24 kHz mono WAV), durationMs, sourceLanguage,
            label, speechEndMs, origin: 'mic' | 'corpus', createdAt }

Run { id, recordingId, architecture, providerTriple, modelSnapshots,
      armTag: 'A' | 'B' | 'C' | 'ad-hoc',
      origin: 'sweep' | 'manual',
      status: 'complete' | 'failed',
      timings, transcripts, outputAudioPath, cost, errors, createdAt }
```

**Corpus clips are Recordings** with `origin: 'corpus'`, so the scripted corpus and ad-hoc recordings flow through one path and one UI.

**Recording lifecycle.** The library lists Recordings with their origin, duration, language, and run count.

- **Labels are editable.** Everything else is immutable — a Recording's audio never changes, or the Runs against it stop being comparable.
- **Deletion is soft.** A deleted Recording is hidden from the library; its audio and its Runs are retained. Hard deletion of the audio is a separate, explicit purge.
- **Corpus Recordings cannot be deleted at all.** Experiments depend on them, and a hard delete would orphan every Run referencing them and break the per-Recording view.

The rule behind all three: **a Run must always be able to reach the input that produced it.** Anything that breaks that link is disallowed rather than warned about.

**Runs of the same Recording are comparable by construction** — identical input is a property of the data model, not something a harness arranges.

**Replay is paced at 1×**, in the same 20 ms framing as live capture. Dumping the clip as fast as the socket accepts would invalidate VAD, endpointing, and every latency figure. Asserted by test (§13, 7).

`speechEndMs` is computed once from the waveform and stored on the Recording, so `t0` is identical across every Run of it.

**Experiments are a derived subset.** Exp 1 and Exp 2 aggregate runs whose computed `armTag` matches a named arm, whose `origin` is `sweep`, **and whose `status` is `complete`**. Ad-hoc and manual runs are first-class and visible in the secondary tab; they are simply not evidence. See the quarantine rules in §6.

**Failed runs are saved, visible, and excluded from every aggregate.** A run that loses a stage to a timeout or an empty result is real information — it belongs in the ledger and in the per-Recording view — but it is not a latency sample.

**Provenance reports actual N, never intended N.** If a sweep intended five repetitions and one failed, the provenance line reads `4 of 5 reps completed`. Silently aggregating over four samples while the line claims five is precisely the kind of quiet error this document exists to prevent.

### The batch runner

A **batch action** runs a matrix — selected Recordings × selected configurations × N repetitions — sequentially, writing Runs to the same ledger as manual runs. Single manual runs remain for exploration.

It applies counterbalanced run order and warmup discard (§8) automatically and records that it did — which is what makes `origin: 'sweep'` meaningful. *(§17, 22f.)*

**Behaviour during a long batch.** A sweep is a ~68-minute operation, so it is specified like one:

- **Progress is visible** — current run, position in the matrix, elapsed and estimated remaining.
- **Cancellable at any point.** Completed runs are retained; the batch simply stops. A cancelled sweep is a short sweep, not a discarded one.
- **A failed run does not abort the batch.** It is recorded as `status: 'failed'`, **retried once**, and the batch continues. Failures are summarised at the end rather than interrupting an unattended run.
- **Short rep counts are surfaced, not hidden.** If a configuration ends with fewer completed reps than intended, the results provenance says so.

**Scale:** Exp 1 is 3 recordings × 5 reps × 2 arms = 30 runs; Exp 2 adds 15. At ~2.25 minutes of audio per pass, a full sweep across both directions is roughly **$4 and ~68 minutes of unattended wall-clock** — replay is paced at 1×, so duration is bounded by real time, not by compute.

### What each mode measures, and why neither substitutes for the other

**Replay — per Run, directly comparable across runs of the same Recording**

| Metric | Definition |
|---|---|
| End-to-end latency | `speechEnd → first audio out`. The headline number |
| Per-stage breakdown | 5 labelled intervals (cascade) or 3 with one opaque (Realtime) |
| Cost per minute | metered spend for the run ÷ audio duration. A **snapshot** — a ≤1-minute clip accumulates almost no conversation context |
| WER | source transcript vs the corpus reference. Real for cascade; labelled *sidecar* for Realtime |
| Adequacy / fluency 1–5 | blind human scoring of the output |
| Observable intervals | 5 vs 3 — the auditability gap, quantified |

**Live — per LiveSession, self-contained**

| Metric | Definition | Why Replay can't produce it |
|---|---|---|
| p50 / p95 latency | across the session's utterances | — |
| **Latency drift** | p50 in minute 1 vs the final minute | needs a multi-minute session |
| **Cost slope** | $/min in minute 1 vs $/min in the final minute, measured under each context policy | Realtime bills the accumulated conversation each turn, so cost per minute climbs. A ≤1-minute clip cannot show it |
| Utterances completed / attempted | dropped-turn rate under sustained load | — |
| Disconnects / reconnects | session survival | needs sustained duration |
| Heap start → end | leak detection over the session | needs sustained duration |
| Subjective quality notes | listening impressions | — |

### Context management

Context policy is evidence for the write-up's **controllability** dimension (rubric criterion #8). It is not a third experiment, does not enter §3's reporting hierarchy, and is never pooled with Exp 1 or Exp 2 — but it carries its own provenance line. *(Rationale: §17, 21e.)*

**Where it applies:**

- **Replay: zero context, always, both architectures.** A control, not a choice. A ≤1-minute clip holds several utterances, and without this Realtime would accumulate across them while cascade does not. *(§17, 21c.)*
- **Live: `contextPolicy: 'default' | 'trimmed'` is user-selectable.** The Realtime 5-minute run is performed under **both**.

**`trimmed` means zero context** — delete every conversation item after each completed response. Not a sliding window (an arbitrary N to defend) and not the GA `truncation` parameter (it chooses what to keep, so a quality change cannot be attributed). The `truncation` parameter is the right **production** recommendation and appears in the write-up as one; it is not used as a measurement instrument. *(§17, 21d.)*

**Cascade is already context-free by design** — each turn is translated independently, so it has no slope and the policy does not vary for it. Cascade *could* pass prior turns to MT and would then have a slope priced in text rather than audio tokens; that cell is analysed in the write-up, not measured.

**Reported:** cost slope under each policy, and any quality difference — pronoun and gender errors are where to look.

**Watch for:** less context per turn may make trimmed Realtime measurably **faster**, not merely cheaper. If so, default-context measurements understate Realtime's latency. Measure it deliberately.

**Preflight** confirms that deleting items mid-session does not disrupt the session, and pins the exact event names.

### Where each stability signal is actually measured

**Heap: Replay is the primary test.** Loop one Recording 30 times and sample heap at start and end. Identical input every iteration makes any growth unambiguous — in Live, utterance lengths vary and legitimate variance masks small leaks. The 60-minute fixture soak is the exhaustive version of this and is Replay-shaped.

**Live catches only session-scoped growth** — one long-lived connection with accumulating server-side conversation state, versus many short independent runs. A different and rarer failure mode, worth one check rather than being the main event.

**Heap is an implementation check, not an architectural finding.** It tests whether *our* cancellation, listener removal, and buffer release are correct — the same code paths that serve mode switching and error handling. It is reported as such, never dressed up as a difference between architectures.

**Comparability rules:**

- Runs of the **same Recording** compare directly — identical input.
- Runs of **different Recordings** do not; aggregate across the corpus instead.
- **LiveSessions do not compare on absolute values** — different unstored speech. But the **shape** of the cost curve does compare: flat versus climbing is a property of the billing model, not of what was said.

### Storage — server filesystem, append-only ledger

The server owns the store; the client reads and writes it over REST. No database.

```
corpus/                     committed — the recorded corpus, Recordings with known provenance
data/                       gitignored working state
  recordings/<recordingId>.wav        24 kHz mono PCM16
  recordings/<recordingId>.json       label, language, durationMs, speechEndMs, origin, capturedAt
  runs/<runId>.json         the Run record — config, snapshots, timings, transcripts, cost
  runs/<runId>.out.wav      synthesized output audio
  ledger.jsonl              append-only, one line per run
results/<date>/             committed — exported bundle the write-up cites
```

Runs are append-only and never updated — JSONL's exact shape. *(§17, 20b.)*

**Endpoints:** `POST /recordings` (browser uploads recorded audio, returns id) · `GET /recordings` · `GET /recordings/:id/audio` · `POST /runs` · `GET /runs` · `GET /runs/:id/audio`.

**The Realtime arm needs the audio client-side.** Replay through Arm A goes browser→OpenAI over WebRTC, so the client fetches the recording from `GET /recordings/:id/audio` and paces it at 1× through the same capture path. Its Run record is produced client-side (timings are client-clock per §8) and POSTed back. Cascade runs are orchestrated server-side and written directly.

**Output audio is retained** for later blind scoring — ~500 KB per run, ~100–250 MB total. *(§17, 20d.)*

**`data/` is gitignored; `results/` is committed.** Working state stays local and disposable; `npm run export:results` writes a dated bundle of run records plus a summary for the write-up to cite. That bundle, not the working directory, is what a reviewer reproduces from.

**Durability is explicitly local.** On EC2 the store lives on the instance disk and does not survive replacement. Acceptable, because the committed `results/` bundle is the artifact of record — but stated so nobody assumes otherwise.

### Playback, mode and language switching

**Live: autoplay on.** One architecture, interpreted audio plays as soon as each utterance is ready — voice in, voice out. This is what a reviewer sees within seconds of opening the app, and it is what rubric must-haves #2 and #4 and the 5-minute stability benchmark are written against.

**Replay: nothing autoplays.** Each Run buffers its audio and reports `ready`; the user plays it on demand. This is what makes A/B listening deliberate rather than a memory test, and it is why blind scoring is possible at all.

Per-run states rendered in the UI:

| State | Cascade | Realtime |
|---|---|---|
| in flight | live per-stage progress, 5 intervals | one progress bar, no stage detail |
| ready | transcript, play button, **labelled ms per interval**, total, cost | same, 3 intervals, model interval labelled opaque |
| failed | which stage failed, session continues | opaque failure, session continues |

**Switching:**

- The mode toggle selects the active architecture, switchable **mid-session** — rubric must-have #4.
- A switch requested mid-utterance **queues and applies at the next utterance boundary**. Audio is never cut mid-stream.
- **Language pair is selectable in-session** by the same queue-at-boundary mechanism. One mechanism, three triggers: mode, pair, direction.
- **Direction swap is a dedicated control** (EN→ES ⇄ ES→EN), since both directions are measured separately and run repeatedly.
- Transcript history, language pair, and metrics live above the transport and survive any switch.
- **Disclosed:** Realtime conversation history is held server-side by OpenAI and is lost on switch. Minor for interpretation, but it affects pronoun and gender resolution.

**Language support labelling:**

- The menu labels support per pair — "both modes" or "cascade only" — surfacing the architectural limitation in the product's own navigation.
- **Support is a property of a direction, not a pair.** EN→YUE and YUE→EN are separate claims: one depends on Realtime *producing* Cantonese, the other on it *recognising* Cantonese. The unsupported-output warning fires only when the **target** is Cantonese, so the pair-level pill and the warning can legitimately disagree.
- Selecting a pair Realtime does not list **warns but never blocks** — blocking would prevent the observation the experiment exists to make. The target pane carries a "text looks correct — audio pronunciation may not be" callout.

**Measurement note:** "first audio out" is timestamped when the first audio sample is decoded and queued for playback — the instant it would begin sounding if autoplay were on. On-demand playback does not move that timestamp, and the write-up says so, since the rubric's wording is "perceived latency."

### Session lifecycle — explicit state machine

The session is not implicitly "live." Every state below is represented in the UI, because they describe consent, teardown, cancellation, and whether the 5-minute run can recover without losing history.

| State | UI | Exit |
|---|---|---|
| `idle` | **Start microphone** button, no connection | user starts |
| `requesting-permission` | permission prompt pending | granted → `listening`; denied → `permission-denied` |
| `permission-denied` | recovery instructions, retry affordance | user retries |
| `listening` | input level meter, elapsed timer, **Stop session** | speech detected → `processing` |
| `processing` | per-arm in-flight state and live stage timings | all arms settle → `ready` |
| `ready` | transcripts, timings, playback controls | next speech → `listening` |
| `playing` | active playback indicator on the playing arm | ends → `ready` |
| `switch-queued` | banner naming the pending mode or language | utterance boundary → applied |
| `reconnecting` | banner, transcript history preserved, attempt count | recovered → prior state; exhausted → `disconnected` |
| `disconnected` | reason, **Reconnect**, history intact | user reconnects |
| `stopping` → `stopped` | flushing final utterance, then summary + **Start new session** | user starts again |

Controls persistently visible in every state: mode toggle, language pair, direction swap, start/stop, permission status, connection status, input level.

### Microphone permission — a four-value property

Permission is not a boolean and must never be rendered as a fixed value. It has exactly four states, and the current one is continuously visible wherever session controls are:

| Value | Meaning |
|---|---|
| `not-requested` | no session started yet; nothing has been asked |
| `requesting` | the browser prompt is open, awaiting the user |
| `granted` | capture is available |
| `denied` | capture is unavailable — **blocking** |

**Requirements:**

1. The indicator reflects the live value. A hardcoded or optimistic default is a defect.
2. `denied` **blocks session start.** The user cannot proceed until it is resolved, so it cannot be surfaced as a dismissible or transient element.
3. **Browsers do not re-prompt after a denial** — a subsequent `getUserMedia` call fails immediately with no prompt. A retry affordance alone will appear to do nothing. The UI must therefore communicate the remediation path, not just offer a retry.
4. Permission can be blocked **independently at two layers** — the site permission and the operating system. Remediation guidance must cover both, or a user who fixes one and still fails will conclude the app is broken.
5. Rubric must-have: mic-permission-denied is an explicitly graded error case.

**Visual treatment is delegated to implementation.** This is a small surface and the design handoff deliberately does not prescribe it; any presentation satisfying the five requirements above is acceptable.

---

## 8. Measurement Methodology

### Endpointing — pinned across arms
Voice activity detection silence threshold is **pinned to 500 ms in every arm**. Verified expressible in both: GA shape is `session.audio.input.turn_detection = {type:"server_vad", silence_duration_ms: 500}` for the Realtime session, and the same turn-detection block on the transcription session for cascade.

Endpointing is roughly half the perceived-latency budget and is a pure config dial. Left at provider defaults, the measured architectural gap could be mostly VAD configuration — an invalidation that would be invisible in the data.

**No sensitivity sweep.** With VAD pinned identically, the threshold is a constant added to both arms and cancels in the difference. Sweeping would produce parallel lines restating the constant.

**Instead — VAD offset validity check.** Because the corpus is pre-recorded, true speech-end is computed offline for every clip. We measure `VAD_fire_time − true_speech_end` per arm. If both land near 500 ms the control held; if they diverge (different VAD algorithms), the difference is reported and subtracted.

### Segmentation — "final" defined precisely

Streaming STT emits two different things both commonly called "final," and conflating them changes latency materially:

| Signal | Meaning | Used? |
|---|---|---|
| `is_final` / stable segment | this *segment* won't be revised; more may follow in the same turn | **no** |
| `speech_final` / endpoint | the speaker's **turn** is complete, after the pinned 500ms silence | **yes — this is our trigger** |

**We translate on turn-final only.** A long sentence produces one translation, not several. Clause-level commit was considered and cut (§17) — it lowers latency but requires revision handling across segment boundaries and breaks on verb-final languages.

`SttEvent.type` is therefore `'partial' | 'final'` where `final` means **turn-final**, and adapters must map each provider's signal onto that definition explicitly. The contract test suite asserts this mapping per provider, so "final" cannot silently mean different things across adapters.

Speculative translation on interim results is **not** implemented. Interims get revised, and spoken audio cannot be retracted; the alternative is audible self-correction in medical and legal contexts.

This does not violate "no full-utterance blocking," which concerns waiting on complete *stage outputs*. The pipeline streams throughout: final transcript → MT streams tokens → TTS begins on the first clause → playback begins on the first audio chunk.

### Clocks — one stopwatch for the headline

Realtime audio never reaches our server, so server-side timing is impossible for Arm A. Mixing a browser clock and a server clock introduces unknown skew larger than the effect being measured.

**Headline metric — measured entirely client-side, both arms:**
- `t0` = **true speech end, derived offline from the corpus WAV** — ground truth, identical across arms, not a VAD guess
- `t1` = first audio sample rendered to output
- `perceived_latency = t1 − t0`

**Per-stage breakdown:**
- **Cascade** — server-side timestamps at `audio_in → stt_final → mt_first_token → tts_first_byte → audio_out`. Single clock, so inter-stage durations are valid.
- **Realtime** — client-timestamped API events: `input_audio_buffer.speech_stopped` → `response.created` → first `response.output_audio.delta`. *(GA names. The beta `response.audio.delta` in an earlier draft no longer exists — confirmed live in preflight.)*

### Control philosophy — what is pinned, what is exposed

Every setting in this project sits in exactly one of three tiers. The rule: **anything that can move a number is frozen wherever numbers are produced, and exposed only where varying it is itself the finding.**

| Tier | Meaning | User control | Examples |
|---|---|---|---|
| **1 · Pinned constant** | Variation adds no insight, only risk. Never surfaced as a control. | none | endpointing 500 ms · 24 kHz · turn-final definition · model snapshots · MT `temperature: 0` · Realtime instructions · counterbalanced run order · warmup discard · **Replay context = zero** |
| **2 · Experimental variable** | Deliberately varied, each setting measured and **reported separately, never averaged together** | selectable | architecture (Realtime vs Cascade) · provider triple within a named arm · **Live `contextPolicy`** |
| **3 · Free exploration** | Anything goes; recorded, inspectable, never aggregated | full | ad-hoc Replay runs with arbitrary provider triples · Live sessions generally |

Context policy is the clearest illustration: **pinned to zero in Replay** because Replay produces the comparative evidence and a user changing it between two runs of the same recording would invalidate their own comparison invisibly. **Exposed in Live** because accumulation only manifests over multi-turn duration, and measuring both settings is precisely the finding.

The same logic governs provider selection — frozen inside named arms A/B/C, free in ad-hoc runs, with the ledger drawing the line so the UI never has to.

### Controlled variables — the register

Every arm is identical except the independent variable. Anything below that is not pinned is a confound, and confounds are disclosed rather than discovered.

**Pinned identically across all arms:**

| Variable | Value | Why it matters |
|---|---|---|
| Endpointing | `silence_duration_ms: 500` | ~half the latency budget; a pure config dial |
| Turn-final trigger | turn-final only, never segment-final | changes when translation starts |
| Audio | 24 kHz mono PCM16, same corpus clips | identical input is the basis of the comparison |
| `t0` | corpus-derived true speech end | not a VAD guess that differs per arm |
| Clock | client clock for the headline metric | cross-clock skew exceeds the effect measured |
| Client path | same build, same client code, same browser | both arms traverse an identical path; Replay feeds the Recording through it directly |
| Language pair + direction | fixed per sweep | word order and length differ by pair |
| **Model snapshots** | **pinned explicitly, never aliases** | `gpt-realtime`/`-mini` are aliases that move; a sweep run a week later would silently measure a different model. Record the resolved snapshot id in every ledger row |
| **MT sampling** | `temperature: 0`, fixed system prompt, fixed `max_tokens` | non-zero temperature makes translations irreproducible run to run |
| **Realtime instructions** | fixed, minimal, and **semantically equivalent to the cascade MT system prompt** | if Arm A is told "translate naturally" and Arm B's MT prompt says "translate literally," the experiment measures prompts, not architectures |
| **TTS voice** | pinned per vendor, recorded in the ledger | voice choice moves fluency scores |
| Region | one region, closest to provider APIs | provider RTT is a visible share of the budget |
| **Run order** | **counterbalanced across repetitions** — A→B on odd reps, B→A on even | always running A first systematically advantages or penalises one arm if provider latency drifts across the sweep window |
| **Warmup** | **first utterance per arm discarded** | cold connection and cold provider inflate the first call; it is not representative |

**Necessarily different — disclosed, not controlled:**

| Variable | Why it can't be pinned |
|---|---|
| Transport | WebRTC to OpenAI vs WebSocket to our server (§4). The hop is measured separately |
| Voice identity across vendors | OpenAI and ElevenLabs voices cannot be made the same. This affects fluency scoring, so fluency is reported as vendor-inclusive and never as an architecture claim |
| Prompt surface | Realtime takes session instructions; cascade takes an MT system prompt. Kept semantically equivalent, but they are not the same mechanism |

### Canonical timing vocabulary — one definition, four consumers

The UI, benchmark harness, tests, and write-up all read the **same named events** from the same record. Divergent definitions across those four surfaces is the most likely way this project reports numbers that don't reconcile.

**Cascade — 6 timestamps, 5 reported intervals:**

| Interval | From → to |
|---|---|
| endpointing | `speech_end` → `vad_fired` |
| stt | `vad_fired` → `stt_final` |
| mt | `stt_final` → `mt_first_token` |
| tts | `mt_first_token` → `tts_first_byte` |
| queue | `tts_first_byte` → `audio_queued` |

**Realtime — 4 timestamps, 3 reported intervals:**

| Interval | From → to |
|---|---|
| endpointing | `speech_end` → `input_audio_buffer.speech_stopped` |
| model | `input_audio_buffer.speech_stopped` → first `response.output_audio.delta` — **opaque, explicitly labelled** |
| queue | first `response.output_audio.delta` → `audio_queued` |

**Cascade turn-final signal:** `conversation.item.input_audio_transcription.completed` on the transcription session. Partial deltas arrive as `…input_audio_transcription.delta` and are **not** the trigger (§8 "final means turn-final").

`speech_end` is corpus ground truth in benchmark runs and VAD-derived in live sessions; the record marks which. **Only intervals within one clock are summed.** End-to-end (`speech_end` → `audio_queued`) stays on the client clock in both arms.

**So: 5 observable intervals versus 3, with one of Realtime's three explicitly opaque.** That asymmetry is the observability half of "operational control."

### The utterance record — single source of truth

One record per utterance per arm, persisted and exported:

```
{ id, arm, mode, languagePair, direction,
  sourcePartials[], sourceFinal, targetPartials[], targetFinal,
  audioState, audioDurationMs,
  timings: { <named events above> }, speechEndSource: 'corpus' | 'vad',
  providers: { stt, mt, tts }, costUnits, error?, corpusId, runId }
```

The live card renders it, aggregation computes p50/p95 from it, JSON export ships it, and the write-up cites it. **Per-stage milliseconds are displayed as labelled numbers, not proportional bars alone** — the rubric requires per-stage latency visible to the user, and a bar without a number does not satisfy that.

### Results view — in-app, not offline

The product is a **workbench**, not an interpreter. Its user is an engineer choosing an architecture, so measured results are a primary screen rather than back-office output.

**One ledger under every view.** Every screen reads from a single append-only run ledger of utterance records (§8) grouped by run and experiment. Curated screens sit *above* it; the ledger is the source of truth, so a metric cannot drift between screens or between a screen and the write-up. Every run row carries its configuration, pair, providers, thresholds, errors, evaluator method, and provenance.

**Empty states are mandatory.** A results card renders "no runs recorded" until real data exists. Sample figures anywhere — including `wireframes.html` — are labelled **illustrative** at card level, so polished placeholders can never be mistaken for measured evidence.

**Two levels, because they answer different questions.**

**Primary — per-experiment aggregates.** Each screen titled with its research question, aggregating **60 samples per arm** (12 utterances × 5 repetitions), reporting p50 and p95:

| Screen | Content |
|---|---|
| **Does the architecture itself cost latency?** | Exp 1 — Arm A vs Arm B: p50, p95, cost/min, WER, adequacy, fluency, observable interval count |
| **What does swapping providers buy?** | Exp 2 — Arm B vs Arm C: p50, p95, cost/min, WER, fluency |
| **What changes as the conversation continues?** | Sourced from `LiveSession`s, not Replay runs. Columns: Realtime-default, Realtime-trimmed, Cascade. Carries the context-policy comparison, since that comparison *is* a cost-slope comparison |
| **What does provider choice let us reach?** | Per-pair coverage by **stage** (realtime / STT / MT / TTS), so a failure is attributable to a stage rather than the pair. Per-cell observation notes for qualitative findings a matrix cannot hold. Time-to-add a pair and a provider, **each citing commit hash and diff size**, plus the realtime equivalent (no mechanism at any price) |

**Secondary tab — two groupings of the same run data.**

- **By Recording** — three rows per recording, one per configuration, each aggregating that recording's 20 samples (4 utterances × 5 reps). Low-information by construction, since categories are distributed evenly across recordings — but it is how you navigate your own recordings, and **ad-hoc runs appear nowhere else**, being excluded from experiment aggregates by design.
- **By utterance category** — where the heterogeneity actually lives. This is the grouping that produces findings: *"cascade's p50 is comparable overall but loses 400 ms on numbers and dates"* is a result; *"recording 2 was 30 ms slower than recording 1"* is noise. Utterances already carry category tags, so this is one additional `groupBy`.

Every result carries a **provenance line** — corpus version, utterance count, repetitions, pinned endpointing value. A number without provenance is a claim; a number with it is citable. This also surfaces the pinned VAD setting in the product rather than in a footnote.

Consequence: the write-up narrates screens a reviewer can open, rather than asserting numbers they must take on trust.

### Stability — treated as a third comparison dimension, not a checkbox

The rubric lists "sustain a 5-minute back-and-forth conversation without disconnection, audio drift, or memory leaks" under performance benchmarks. Read as a pass/fail check it sits oddly against the two experiments. It is therefore **run on both arms and reported as a comparison**, because the failure modes differ by architecture:

- **Realtime** holds one long-lived session on OpenAI's terms — session duration limits, token expiry, reconnection policy. A drop loses conversation context, and the cause is not instrumentable.
- **Cascade** holds a per-utterance STT stream plus short-lived MT and TTS calls. A drop costs one utterance. State lives in our process, so reconnect is cheap and lossless.

This is the **controllability axis measured over time** rather than per utterance — the same question Experiments 1 and 2 ask, along a different axis.

Two things it exposes that per-utterance measurement structurally cannot:

1. **Latency drift.** Capture and playback run on different clocks; a 0.1% mismatch is ~300ms over five minutes. Separately, if TTS generation trails realtime playback and the buffer only ever appends, latency creeps upward across the conversation.
2. **Cost slope.** Realtime replays conversation history each turn, so context grows and **minute 5 costs more than minute 1**. Cascade is flat — each utterance is independent. The Exp 1 cost figure is a snapshot; this converts it into a slope, which is the commercially relevant form for per-minute interpretation pricing.

**Metrics captured per arm:** utterances completed/attempted · disconnects · p50 at minute 1 vs minute 5 · latency drift · cost at minute 1 vs minute 5 · heap start→end · context lost on drop.

**Method — free-form microphone, no fixed input.** Live mode is exactly what it says: you speak, up to five minutes. Sessions may be any length; **at least one run per arm is a full five minutes** to satisfy the rubric's benchmark verbatim.

**Identical input is deliberately not required here.** The finding is the *shape* of the cost curve — flat versus climbing — and shape is a property of the billing model, not of what was said. Two sessions of entirely different speech still produce one curve that climbs and one that does not. Requiring a fixed recording would buy precise absolute head-to-head figures that speech density makes approximate anyway, and would cost something real: a replayed file never exercises the microphone capture path, which is where audio drift originates.

**One operational note:** keep the sessions broadly similar in character — comparable speech density and turn length. The shape comparison is robust to different words, not to one session of constant speech against another that is mostly silence.

Run once per arm, and for Realtime once per context policy. Reconnects and per-utterance latency instrumented continuously; heap sampled at start and end. Separately, a **60-minute fixture-provider loop** for leak detection — free, unattended, and where leaks actually surface (§8).

### Benchmark harness — the app itself

**There is no separate harness.** The batch runner (§7) executes sweeps inside the app, through the same code path as a manual Replay run.

An earlier design used Playwright with Chrome's fake-audio-device flags to feed corpus clips through the real SPA, because the only audio source was a microphone and Realtime's browser→OpenAI WebRTC path could not be exercised from Node. **The Replay flow removed that need entirely** — a Recording is fed directly through the client at 1×, in the browser, on the real path. No fake device, no external driver, no second implementation to keep in sync.

- **5 repetitions** per utterance per arm → **60 samples/arm** → p50 and p95
- **Runs execute sequentially**, never concurrently — concurrent streams contend for network and CPU, and the effects measured are ~100 ms
- Counterbalanced ordering and warmup discard applied automatically, and recorded as `origin: 'sweep'`
- Runs written to the same ledger as manual runs; the results view reads that ledger
- **Failover disabled** — not implemented (§17)
- Estimated full sweep, both directions: ~2.25 min audio per pass, **~$4 and ~68 minutes** of unattended wall-clock. Replay is paced at 1×, so duration is bounded by real time rather than compute.

### Fixtures — hard rule
Fixture providers replay canned output on configurable timers with fault injection. They are used for development, CI, error-path tests, and long-running stability runs.

> **No number reported in the write-up may come from a fixture run.** Fixture latency is a configured constant. Every latency, cost, and quality figure comes from real providers on real audio.

---

## 9. Corpus

**9 Recordings holding 36 utterances, ~4 minutes of audio, committed with reference material.**

| Set | Recordings | Utterances | Method | Reference | WER? |
|---|---|---|---|---|---|
| **English** | 3 | 12 | Self-recorded, **read verbatim** | Written script | ✅ |
| **Spanish** | 3 | 12 | Coworker, **read verbatim from written script** | Written script | ✅ |
| **Cantonese** | 3 | 12 | Self-recorded, **improvised from English prompt cards** | Corresponding English utterance (meaning) | ❌ |

**Packaging: 3 Recordings per direction, ~4 utterances each, ≤45 s per recording.**

Recordings and utterances are decoupled. Utterance count drives statistical N and WER word count; recording count only affects run count. Three short takes rather than one long one is a **recording-ergonomics** decision: reading two continuous minutes of scripted, deliberately varied speech — including performed disfluencies and an interruption — without a stumble is hard, and a bad 45-second take costs 45 seconds to redo. That matters most for the Spanish side, where the favour being asked of a coworker is three short reads rather than one perfect long one.

**Categories are distributed across the recordings, not grouped.** If the numbers, disfluency, and interruption utterances all landed in one recording, that recording's aggregate would look systematically worse and someone would read meaning into it. Mixed recordings are comparable; category analysis comes from per-utterance tags.

**Every utterance carries a category tag** — the tag, not the recording, is the meaningful analytical grouping (§8 results view).

**Format:** 24 kHz mono WAV PCM16 (matches transport — no resampling in the measured path).

**Six categories, 2 each per direction** — chosen because the architectures diverge here, not on clean sentences:
1. Short one-word reply
2. Long compound sentence
3. Numbers, dates, dosages
4. Proper nouns
5. Disfluency / false start
6. Interruption

**Cantonese method:** the author speaks Cantonese but does not read it. Since WER is not computed for Cantonese, no written Cantonese script is required — English prompt cards are read silently and rendered in Cantonese in the speaker's own words. The reference is the original English utterance, giving a parallel set across both directions.

**Operational requirement:** the Spanish script is written out and read **verbatim**. Improvised Spanish would leave no ground truth and eliminate Spanish WER.

**Disclosed asymmetry:** English and Spanish are read speech (needed for verbatim WER); Cantonese is improvised (more natural, but no verbatim reference). The two corpora feed different metrics.

---

## 10. Quality Measurement

### WER — reported honestly, with scope
- **Cascade (Arms B, C):** WER on the STT transcript. Valid — this transcript is the actual pipeline input.
- **Realtime (Arm A):** reported **explicitly labeled as a sidecar measurement.**

**Why the label matters.** Realtime produces no source transcript as a byproduct. Satisfying the "show source text" requirement forces enabling `input_audio_transcription`, which runs **a separate STT model in parallel** (~$0.006/min on top of Realtime's higher rate). That transcript is a second model's guess about the audio — **not what the model translated from.** They can disagree.

This yields a core finding: **cascade's transcript is auditable — it *is* what got translated, and a wrong output can be traced to a stage. Realtime's is not.** For medical and legal interpretation, that is a compliance and liability question, not a technical footnote.

**Disclosed limitation:** ~150 reference words per direction. One misrecognized word moves WER ~0.7pp. Adequate for detecting large gaps, **reported as directional, not precise.**

### Translation quality — blind human scoring, built into the app

Because Replay never autoplays, blind comparison is a natural feature rather than an offline chore. **"Compare blind" hides configuration identity** across two Runs of the same Recording, presents the outputs as Sample A and Sample B in randomized order, and asks for a **1–5 rating on adequacy and fluency**. Identity is revealed after submission, and scores append to the results view.

**Randomization is per comparison, not a fixed swap**, and the drawn assignment is **persisted to the run ledger** alongside the score. A fixed A↔B inversion would teach the evaluator the mapping after a single reveal; persisting the draw is what makes the blinding auditable after the fact rather than merely asserted.

### Scoring workflow

**Launched on demand from the per-Recording view**, where two Runs of the same input sit side by side. Scoring is not a phase you must complete; it is available whenever a comparison is worth judging.

- **Two configurations at a time.** With three or more Runs of a Recording, the evaluator picks the pair. Pairwise comparison is what a human can actually judge; ranking three simultaneously is not.
- **Sampled, not exhaustive.** Scoring every Run of every Recording is neither necessary nor realistic. The **number of comparisons scored is stated in the provenance line** alongside N, so a small sample is disclosed rather than implied to be complete.
- **Playback only** — the evaluator hears both outputs and rates adequacy and fluency 1–5. Neither transcript is shown before submission, because reading the text would let the Mandarin-pronunciation class of error pass unnoticed (§11).
- **No account or special mode.** A Spanish-speaking coworker scores at the same machine or on the deployed instance; there is no auth in scope (§2), so the workflow is simply handing over the screen or the URL.
- **Scores append to the ledger** with the drawn assignment, the evaluator's language, and the Runs compared.

- **Spanish** — scored in-app by the Spanish-speaking coworker
- **Cantonese** — scored in-app by the author (native speaker)
- Plus the author's listening notes on prosody, naturalness, number/proper-noun survival, and disfluency handling

Blind scoring by native speakers is used rather than an LLM judge: at N=24 this is more credible and costs nothing. Building it into the product removes the spreadsheet step and guarantees the ordering was actually randomized.

### Cantonese — audio-first, no WER
Evaluated **by ear**, both directions. Stated plainly in the write-up: *quality assessed by ear by a native speaker; WER not computed for lack of a verified written reference.*

**Specific check:** written Cantonese shares most characters with Mandarin. A TTS that does not distinguish the spoken languages will read Cantonese text aloud **in Mandarin** — output that looks correct in the transcript and is wrong in the audio. **A text-only evaluation scores this as a success.** Detectable only by listening, and only by a speaker.

---

## 11. Language Pairs

| Pair | Scope |
|---|---|
| **EN ↔ ES** | Fully measured — latency, WER, quality, cost |
| **EN ↔ YUE (Cantonese)** | Measured audio-first, both directions, no WER |

**Cantonese as the uncommon-pair test.** Provider support splits along the exact line under test:

Cantonese is tested against the **same two vendors chosen for Spanish** — nothing is added to make it work:

| Stage | Provider | Status |
|---|---|---|
| STT | `gpt-4o-transcribe` | **to verify** — Whisper-lineage models list Cantonese, quality unknown |
| MT | `gpt-4o-mini` | expected fine — written Cantonese is well within an LLM's range |
| TTS | ElevenLabs Flash v2.5 | **to verify** — ElevenLabs Cantonese STT is confirmed; TTS voice coverage is not |
| Realtime (Arm A) | `gpt-realtime` | **not listed** among supported output languages |

**No third vendor will be added to make Cantonese work.** Testing it against the vendor set already chosen for Spanish is the honest experiment; shopping for a vendor until the answer comes out right is not. If both OpenAI STT and ElevenLabs TTS fail on Cantonese, *that is the finding* — cascade's flexibility is bounded by what its vendors actually cover.

Whichever way coverage lands, the result is reportable:

| Outcome | Finding |
|---|---|
| Flash v2.5 covers Cantonese | Cascade delivers a language Realtime cannot |
| Only a slower model covers it | Uncommon languages cost latency too |
| No coverage | Cascade localizes the gap to **one stage**; Realtime fails opaquely. **Flexibility ≠ coverage.** |

**Realtime is run on Cantonese regardless** (~10 min, ~$0.50) to document the actual failure mode. "Unsupported" is a documentation lookup, not a finding; *how* it fails is the finding — and if it produces fluent-sounding Mandarin, that is decisive evidence for the auditability argument and detectable only by a native speaker.

**Onboarding cost is proven by commit**, not claimed: the diff and elapsed time for adding EN↔YUE are recorded.

---

## 12. Error Handling

**Graceful failure. No automatic failover.**

| Failure | Behavior |
|---|---|
| Mic permission denied | Clear UI message; app remains usable |
| Provider timeout | Abort via `AbortSignal`; fail the utterance; session survives |
| Rate limit (429) | Retry with backoff; then surface a clear error |
| Empty / null result | Skip utterance, log, do not crash the pipeline |
| WebSocket drop | Auto-reconnect with session state preserved |
| Provider hard failure | Surface clearly in the UI; session survives |
| Recording upload fails | Recording not created; the capture is retained in memory so the user can retry without re-recording |
| Recording audio missing or unreadable | The Recording is marked unplayable; its existing Runs remain readable, and new runs against it are blocked rather than failing mid-flight |
| A Run fails mid-execution | Saved with `status: 'failed'` and the stage that failed; excluded from aggregates (§8). In a batch, retried once, then the batch continues |
| Disk full on write | The Run is not written, the batch halts with a clear message, and prior runs are intact — an append-only store must never be left partially written |
| Results export fails | Reported plainly; `data/` is untouched, so export is always re-runnable |

**Failure messages are architecture-differentiated, and that is a finding.** Cascade can name the stage that failed; Realtime cannot:

- Cascade — *"mt stage timed out for this utterance — session still running"*
- Realtime — *"opaque failure — no stage attribution · session still running"*

The auditability gap does not only appear in the happy path's timing breakdown. It appears again, and more sharply, at the moment something breaks — which is exactly when an operator needs attribution. Worth one line in the write-up.

All implemented via the `withRetry` / `withTimeout` decorators — once, applied uniformly.

*The write-up may note as analysis that cascade has a fallback path available and Realtime structurally does not. It will not imply failover was built.*

---

## 13. Testing

**Vitest. All tests run against fixtures — deterministic, fast, zero API spend, CI-safe.**

| # | Test | Purpose |
|---|---|---|
| 1 | **Contract tests** — one shared suite run against *every* implementation of each interface | Proves "swapping a provider is a contained change." A new provider is interchangeable iff it passes. |
| 2 | **Streaming assertion** — first TTS byte arrives before MT finishes emitting tokens | Encodes the "no full-utterance blocking" requirement as an executable check |
| 3 | **Error paths** — fixture injects timeout / 429 / empty result | Session survives; failure surfaces |
| 4 | **Cancellation** — `AbortSignal` mid-stream | No leaked sockets or timers; protects stability benchmark and mode switching |
| 5 | **Instrumentation validation** — fixture with known 200 ms delay measures ~200 ms | **The entire thesis rests on the timing code being correct.** Nothing else would catch a bug here. |
| 6 | **Turn-final mapping** — each STT adapter's turn-final signal maps to `SttEvent.type === 'final'` | Prevents "final" silently meaning segment-final in one adapter and turn-final in another (§8) |
| 7 | **Replay pacing** — a Recording is fed at 1× in 20 ms framing, not dumped | Dumping the buffer invalidates VAD, endpointing, and every latency figure — and would look like it worked (§7) |
| 8 | **Derived `armTag`** — a configuration matching a named arm derives that tag; any deviation derives `ad-hoc` | Membership must be impossible to mislabel (§6) |
| 9 | **Sweep controls** — the batch runner discards the first run per configuration and counterbalances order | These are §8 requirements; if the runner silently skips them, `origin: 'sweep'` means nothing |

**Plus one real-provider smoke test per path**, run manually, not in CI. Fixtures prove orchestration; they cannot prove a provider still behaves as its adapter assumes. Each path gets one live call asserting a non-empty, well-formed response.

**Not tested:** UI components, provider SDK internals, live network calls in CI.

---

## 14. Deployment & Cost Control

### Deployment
**All AWS, single origin.** One EC2 instance running **Caddy** (automatic TLS, reverse proxy, WebSocket passthrough) fronting the Node service, which also serves the built SPA as static files.

No CORS, one deploy, one dashboard. ECS Fargate + ALB was rejected: task definitions, target groups, health checks, cert wiring, and an idle-timeout default that would silently kill the 5-minute stability test — all for no benefit at this scale.

Region selected for proximity to provider APIs; provider RTT is a visible share of the cascade budget.

### Cost control
| Lever | Effect |
|---|---|
| Fixtures for all dev-loop work | ~60% of total spend removed |
| `gpt-realtime-mini` for development | ~3× on Realtime |
| Frequent session resets in dev (context replay compounds) | 2–3× on long sessions |
| Prompt caching on Realtime ($0.40/M cached vs $32/M) | Large |
| Deploy in week 2 only; tear down after | ~$15 |
| Two vendors in the measured arms | No third account, no third adapter, no third smoke path |
| Batch sweeps run deliberately, not continuously | a full sweep is ~$4 |

**Projected total: $30–50.** Spend to date ≈ $0.01 (§15).

---

## 15. Build Status & Remaining Work

The original day-by-day plan is retired — the first build ran and converged. What follows is the current state.

### Built and verified

| Area | State |
|---|---|
| `core/` — stage interfaces, contract suite, decorators, fixtures, registry, timing | complete, unchanged by later decisions |
| `server/providers/` — OpenAI STT / MT / TTS, ElevenLabs Flash TTS | complete, preflight-verified against live APIs |
| `server/cascade/orchestrator` — streaming pipeline, turn-final handling, timing capture | complete |
| `server/ws`, `server/token` | complete |
| `client/audio/` — capture, PCM, playback | complete |
| `client/transport/` — realtime, cascade | complete |
| `harness/` — wav, corpus loader, bench | complete |
| Tests — contract, streaming order, error paths, cancellation, instrumentation validation, turn-final mapping | passing; QA loop converged over two clean consecutive passes |

Preflight resolved four assumptions into observations: 24 kHz (16 kHz rejected), GA realtime event names, the cascade turn-final signal, and confirmation that `gpt-4o-transcribe` remains available. Total spend to date ≈ $0.01.

### Remaining

Ordered by dependency, not by day.

| # | Work | Why outstanding |
|---|---|---|
| 1 | **Recording / Run entities + filesystem storage + REST endpoints** | Replay mode did not exist in the first build |
| 2 | **Replay mode: 1× pacer, run trigger, per-Recording view** | as above |
| 3 | **Live mode rework** — single architecture, ≤5 min, `LiveSession` metrics, audio discarded | first build used the retired fan-out model |
| 4 | **Router: fan-out → switch** | simplification following from 3 |
| 5 | **Context policy** — zero in Replay, toggle in Live | decided after the build |
| 6 | **Adapters: ElevenLabs Scribe v2 STT, Claude Haiku MT, `gpt-4o-mini-transcribe`, ElevenLabs Multilingual v2** | second real option per stage |
| 7 | **Per-stage model selection UI** | first build offered arm presets only |
| 8 | **Derived `armTag` + `origin`** | replaces explicit tagging and the retired abort guard |
| 9 | **Batch runner** — counterbalancing, warmup discard, progress, cancel, retry-once-then-continue | control enforcement plus the ergonomics of a 68-minute unattended operation |
| 9b | **Run `status`, Recording lifecycle, blind-scoring workflow, storage error paths** | gaps found in the product-manager review; none existed in the first build |
| 10 | **Results rework** — per-experiment primary, per-Recording and per-category secondary, stability re-sourced to `LiveSession`s | model changed underneath the existing screens |
| 11 | **Real corpus** — 9 Recordings, 36 utterances | needs the author and a Spanish-speaking coworker |
| 12 | **Sweeps, WER, blind scoring** | blocked on 11 |
| 13 | **ElevenLabs key scope** — add `speech_to_text` and `user_read` | blocks the Scribe adapter and the outstanding billing verification |
| 14 | **Deploy** — EC2 + Caddy | AWS credentials absent |

**Approach: incremental, not a rebuild.** Roughly half the source survives unchanged, and it is the expensive half — adapters encoding preflight-discovered protocol details, the streaming orchestrator, and the interface/contract/decorator foundation the current PRD still specifies. The half that changes is UI and view state, which is both the cheapest layer to rebuild and the one being redesigned anyway. A change manifest naming keep / modify / add / delete per file precedes the next agent run, so the delta is *told* rather than *discovered*.

### Process rules
- **Commit continuously**, scoped to logical units. The sequence above produces natural commit boundaries. Git history reflecting iterative development is graded and cannot be reconstructed afterward.
- **AGENTS.md written from day 1**, accreted live — actual instructions that worked, corrections made, places the agent was overridden. Written from memory on day 10 it would be vague and partly invented.

---

## 15A. Cut — 2026-08-09

Cut against the brief's 3–4 day / 15–20 hour envelope. **A cut item is not a debt.** None of these
is graded; each was costing days.

| § | Cut | Reason |
|---|---|---|
| §7, §8 | **5-repetition sweeps → 3** | 3 reps gives p50 and a defensible interval. p95 over 60 samples of read speech is precision nobody is grading, and it halves the operator's blocked time. |
| §10 | **In-app blind pairwise scoring as a graded subsystem** | A whole subsystem for one evaluator and ~24 judgements. **The component stays** (`BlindCompare.tsx` is built and works) and the operator uses it — but the finding is a listened-to note in `FINDINGS.md`, not a persisted scoring corpus. |
| §7, §8 | **Heap sampling / leak detection / 60-minute fixture soak** | The rubric asks only for *"without… memory leaks"* inside the one 5-minute session. One before/after heap number there satisfies it. See ticket 058 — the scaffolding is typed through five layers and hardcoded `null`. |
| §8 | **Counterbalanced order + warmup discard as enforced machinery** | Real methodology, but at 3 recordings it is a paragraph of disclosure, not a runner feature. **The batch runner already implements it and stays** — this cuts the obligation to defend and extend it, not the code. |
| §14 | **EC2 + Caddy deploy** | Rubric: *"Optional… Local-only with clear setup instructions is fine."* AWS credentials absent. |
| §7 | **Recording soft-delete / purge / undeletable-corpus lifecycle** | Three rules and their tests defending a library of four items. |
| §5, §6 | **Second SAME-VENDOR option per stage** (`gpt-4o-mini-transcribe`, `eleven_multilingual_v2`) | The rubric grades the *cross-vendor* swap. Two options per stage prove it; the same-vendor contrast is a nice-to-have. |

### Explicitly NOT cut — ruled in, 2026-08-09

- **The Cantonese track (§5, §9, §11) stays.** The rubric's *"minimum: English ↔ Spanish"* is a
  floor. Cantonese is the only place this project answers *provider flexibility* and
  *time-to-onboard a new language pair* — two named Key Impact Metrics — with evidence rather than
  assertion. It is also the sharpest evidence for the auditability thesis: §10's Mandarin-
  pronunciation trap is a failure *a text-only evaluation scores as a success*.
  **Consequence:** retaining output audio per run (ticket 056) becomes **load-bearing**, because
  that finding is audible only. It moves ahead of the sweep.
- **The Help tab stays.** Not in §16 and not in the rubric, but it is the clearest prose in the
  project and it is the write-up's first draft (ticket 057 harvests it). Do not extend it — new
  prose belongs in `FINDINGS.md`.

## 15B. Deferred — not this cycle

| Item | Reason |
|---|---|
| **050 · idempotent run POST** | Requires the server to accept a connection and never respond. Ticket 048 already surfaces the loss in `summary.failures`; the residual is one provenance denominator reading low, and it is pinned by an assertion that must be *updated*, never deleted. |
| **026 · LiveSession records configured rather than actual providers** | The reporting layer is already gated. Deferred by design since it was filed. |
| **053 · provider usage channel** | Complete and green on `tdd/053`, **not merged.** It refines the precision of a cost figure with zero samples behind it. Its findings stand — see the ticket. Reopen only if time remains after the write-up. |

## 15C. Status correction — 2026-08-09

**Every stored record predates the code that would have populated it.** No record carries
`pricingVersion` (they predate `core/pricing.ts`); all 8 LiveSessions store `p50: null` (they predate
ticket 051); 2 of 3 Runs render every stage as `—` for the same reason. **051 and 052 are correct and
landed. Nothing has been re-run since.**

Re-running is worth more than the next three tickets combined, and no amount of further code changes
that.

**§15 item 11 (real corpus) is now partially resolved.** Three EN Recordings were recorded through
the app's own `Record new clip` flow on 2026-08-09 — 12 utterances, every one categorised with
verbatim reference text, `origin: 'corpus'`, `corpusVersion: 'corpus-v1'`. No import step was needed
or built: `RecordTake.tsx` already produces exactly the shape the pipeline consumes. **The 36
committed `corpus/*.wav` files are synthetic tone bursts and are deleted by ticket 054** — the
generator's own header states *"a tone burst + silence tail… NOT speech."*

Remaining on item 11: **YUE takes 1–3** (solo, improvised, no reference text) and **ES takes 1–3**
(blocked on the coworker — the only externally-blocked item in the project).

---

## 16. Deliverables

1. **Browser SPA — Live mode**: mic capture, one architecture at a time, autoplay, ≤5 min, `LiveSession` metrics saved and audio discarded, context-policy toggle, language pair switcher with direction swap and per-mode support labels, live source+target transcripts, labelled per-stage latency
1b. **Browser SPA — Replay mode**: record ≤1 min, Recordings library with editable labels and soft delete, per-stage model selection with live derived-arm display, manual run trigger, batch runner with progress and cancel, on-demand pairwise blind scoring
1c. **In-app results view** — four per-experiment screens plus a secondary tab grouped by Recording and by utterance category, each with provenance and mandatory empty states
2. **Node/TS backend** — ephemeral token endpoint, cascade orchestrator, provider adapters, Recording/Run storage and REST endpoints
3. **Batch runner** — in-app sweep execution with counterbalancing and warmup discard; results JSON export
4. **Test suite** — Vitest, nine categories per §13, plus one real-provider smoke test per path
5. **Corpus** — 9 Recordings holding 36 tagged utterances, with reference material
6. **Comparison write-up** — 1–2 pages: latency, quality, cost, controllability, scenario-based recommendation
7. **README** — setup, run, architecture
8. **AGENTS.md** — how the coding agent was directed
9. **Deployed instance** — EC2 + Caddy

---

## 17. Decision Log

| # | Decision | Rationale |
|---|---|---|
| 1 | Node/TS full stack | Real-time audio orchestration problem; best-trodden path; one language front-to-back |
| 2 | Realtime via direct browser↔OpenAI WebRTC | OpenAI's recommended browser pattern; a relay would fight the <1.5s benchmark |
| 3 | Cascade via WebSocket + PCM16 | WebRTC ingest requires a jitter buffer (+40–100 ms) and Opus transcode — measurably *slower* on a stable connection |
| 4 | All AWS, single origin, EC2 + Caddy | Rubric prefers AWS; splitting origins buys nothing and costs CORS + two pipelines; Fargate/ALB is config surface with an idle-timeout trap |
| 5 | Two experiments, different controls | Mixing vendor and architecture changes would confound the headline number |
| 6 | MT held constant across Arms B and C | Isolates the STT/TTS swap; peer LLMs are indistinguishable at N=24 anyway |
| 7 | VAD pinned 500 ms; no sensitivity sweep | Endpointing is ~half the latency budget; pinned identically it cancels in the difference, making a sweep redundant |
| 8 | VAD offset validity check | Different VAD algorithms may fire at different real moments despite identical nominal settings |
| 9 | Translate on finals, not interims | Spoken audio cannot be retracted; ~400 ms is not worth audible self-correction in medical/legal contexts |
| 10 | Client-side clock, corpus-derived `t0` | Realtime never reaches our server; cross-clock skew would exceed the measured effect |
| 11 | Measurement runs in the browser, not a Node harness | Only way both arms traverse the identical client path. Originally Playwright-driven; superseded by Replay (24a) |
| 12 | Fixtures never produce reported numbers | Fixture latency is a configured constant |
| 13 | Blind human scoring, not LLM judge | At N=24, native-speaker blind scoring is more credible and free |
| 14 | Mid-session toggle | Forces the graded transport/UI separation; best demo moment |
| 14b | In-session language switching, same boundary rule | Cantonese and Spanish arms are run back to back; restart-per-pair would add friction to every measurement run. Reuses the mode-switch mechanism rather than introducing a second concept |
| 14c | Unsupported-language warning does not block | Blocking would prevent the observation the experiment exists to make |
| 14d | Router fans out to all arms simultaneously *(superseded by 19b)* | The product is a comparison workbench. Showing one arm at a time makes comparison a memory test, and sequential live runs can never use identical input |
| 14d-i | **No autoplay; play each arm on demand** | Removes audio collision by construction rather than arbitration. Makes A/B listening deliberate. Does not affect the latency timestamp, which is taken at decode/queue |
| 14d-ii | Autoplay available only with one arm active | Restores true voice-in/voice-out for rubric #2 and the 5-minute conversational stability benchmark, with no extra machinery |
| 14d-iii | Blind compare built into the app | Nothing autoplays, so blind A/B is a natural feature. Removes the offline spreadsheet step and guarantees randomized ordering |
| 14e | Results are an in-app view, not just JSON and a document | The user is an engineer choosing an architecture; results are the primary screen. The write-up then narrates screens rather than asserting numbers |
| 14f | Every result carries a provenance line | Corpus version, N, repetitions, pinned endpointing. Turns a claim into a citable figure and surfaces the VAD control in-product |
| 14g | Sweeps run arms sequentially, never concurrently | Concurrent streams contend for network and CPU; the measured effects are ~100ms |
| 14h | Stability run on **both arms** and reported as comparison | As a pass/fail check it sits apart from the experiments. As a per-arm comparison it is the controllability axis measured over time, and it is the only place Realtime's cost slope and latency drift become visible |
| 14i | Flexibility matrix broken out by stage, with observation notes | A pair that fails should be attributable to a stage. Qualitative findings — such as correct-looking text with wrong pronunciation — cannot live in a matrix cell |
| 15a | Non-pooling rule + fixed reporting hierarchy | Three tracks answer three questions with three control strategies. Pooled statistics would make attribution ambiguous and weaken the headline |
| 15b | App **defaults to single-arm live mode** with autoplay on | A reviewer must see voice-in/voice-out and a literal mode toggle within seconds. Comparison is one click away. Default-state change, not an architecture change |
| 15c | Explicit session lifecycle state machine | Consent, teardown, cancellation, and reconnect-without-history-loss are graded behaviours, not polish. `idle` and `stopped` were entirely missing |
| 15d | Canonical timing vocabulary + single utterance record | UI, harness, tests, and write-up previously risked four definitions. Also resolved a real §7/§8 inconsistency: Realtime has 3 intervals, not 2 |
| 15e | Per-stage latency shown as **labelled milliseconds** | Rubric requires per-stage latency visible to the user. Proportional bars and a "stages seen" count do not satisfy it |
| 15f | "Final" defined as **turn-final**, asserted per adapter | The term was ambiguous between stable-segment and end-of-turn; the two differ materially in latency |
| 15g | One run ledger beneath all result views; mandatory empty states | Prevents metric drift between screens and the write-up; stops polished placeholders reading as measured evidence |
| 15h | Day-0 provider preflight before freezing interfaces | API churn is the largest external risk. Preflight also revealed `gpt-realtime-translate` is duration-billed, which reframes the cost-slope finding |
| 15i | WebSocket-vs-WebRTC restated as a hypothesis | It was reasoned, not measured. The transport hop is instrumented and reported as a number instead |
| 16a | Failure copy differentiated by architecture | Cascade names the failed stage; Realtime cannot. The auditability gap reappears at the moment attribution matters most |
| 16b | Blind draw randomized per comparison and persisted to the ledger | A fixed A↔B swap stops being blind after one reveal; persisting the draw makes the blinding auditable |
| 16c | Language support labelled per direction | EN→YUE and YUE→EN are different claims — producing Cantonese versus recognising it |
| 16d | Mic permission specified as a four-value property, **design delegated** | It is one small indicator plus one blocking case, not a screen worth reworking the handoff for. The functional constraints — no re-prompt after denial, two independent blocking layers — are what actually determine correctness |
| 17a | **Third STT vendor cut; Arm C swaps TTS only** | The earlier Arm C changed STT *and* TTS at once, so its delta was unattributable to either stage. One variable restores attribution. Two vendors already demonstrate multi-vendor composition; Exp 2 was never about vendor count |
| 17b | 24 kHz PCM16 end to end, not 16 kHz | Preflight: OpenAI's transcription session rejects rates below 24000. Verified live, not assumed |
| 17c | GA realtime event names adopted | `response.output_audio.delta`, not the beta `response.audio.delta`; turn-final is `conversation.item.input_audio_transcription.completed`. Observed live |
| 17d | ElevenLabs cost figures blocked pending billing verification | The API key is TTS-scoped, so `/v1/user/subscription` 401s and aggregate-vs-per-chunk billing could not be measured. No ElevenLabs cost may be reported until resolved |
| 18a | Controlled-variable register added, with six newly pinned items | Model snapshots, MT sampling, Realtime instructions, TTS voice, run order, and warmup were all free to vary. Unpinned model aliases alone would have made sweeps irreproducible across days |
| 18b | Realtime instructions must be **semantically equivalent** to the cascade MT prompt | Otherwise the experiment measures prompt wording, not architecture — the most invisible confound available |
| 18c | Run order counterbalanced; first utterance per arm discarded | Fixed ordering plus provider-latency drift systematically favours one arm; cold-start inflates the first call |
| 18d | Runtime provider switching added, but **quarantined** from measured arms | Swappability is a graded capability and an onboarding measurement. Letting it reach the sweep configuration would convert the product's best feature into the experiment's worst confound |
| 19a | **Replay flow: record a take, replay it through any configuration, save every run** | Identical input stops being something the harness arranges and becomes a property of the data model. Two runs of the same take are directly comparable by construction |
| 19b | **Fan-out retired; Replay runs are sequential** | Fan-out existed to guarantee identical live input. A saved take does that better and removes concurrent-network contention from the measured path |
| 19c | **Live mode retained alongside Replay** | Record-then-replay is neither "voice in, voice out" (rubric #2) nor a 5-minute conversation (stability benchmark). Live mode costs nothing — the path already exists — and produces no reported figures |
| 19d | Replay paced at 1× with live framing | Dumping a take as fast as the socket accepts would invalidate VAD, endpointing, and every latency figure. Asserted by test |
| 19e | Two same-vendor and cross-vendor options per stage | A same-vendor swap isolates model choice; a cross-vendor swap isolates vendor choice. Conflating them is the usual failure of provider comparisons |
| 19f | Ad-hoc runs are first-class but never aggregated | Free exploration is the product; evidence is a labelled subset. The ledger draws the line so the UI doesn't have to |
| 19g | **Live mode runs exactly one architecture** | Its purpose — voice in, voice out, one audible output, a real conversation — is single-arm by nature, and comparison moved to Replay. Collapses audible-arm selection, the overlap warning, the add-arm affordance, the multi-column grid, and fan-out out of the design |
| 19h | **Live persists no audio and creates no `Run` records** | Privacy and storage aside, it protects provenance: every Recording is then a deliberate recording, not an unidentifiable live fragment. The trade accepted is that an interesting live moment cannot be promoted into an experiment — say it again in Replay |
| 19i | **No separate stability artifact — every Live session is one** | A `LiveSession` is already a ≤5-minute measured session; the rubric's stability benchmark is simply the one run for the full five minutes. Drift and cost slope come from the same per-utterance array. One fewer entity for no loss |
| 20a | **Three entities: Recording (input), Run (execution), LiveSession (session)** | `Take` and `StabilityRun` were poorly named and one was unnecessary. Each remaining entity maps 1:1 to something the user actually does |
| 20a-i | Live session metrics saved, audio discarded | The metrics are real and worth keeping; what they lack is a stored input anything else could be run against |
| 20b | **Filesystem + append-only JSONL, no database** | Runs are append-only and never updated — JSONL's exact shape. A partial write costs one line, not a table. At a few hundred runs, in-memory filtering is instant and a DB buys nothing but dependencies |
| 20c | `data/` gitignored, `results/` committed | Working state is local and disposable; the exported dated bundle is the artifact of record and the thing a reviewer reproduces from |
| 20d | Output audio retained per run | Blind scoring happens later and needs the actual audio. ~500 KB/run is not a constraint |
| 21a | **Cost slope reframed as a controllable default, measured under two context policies** | Realtime exposes `truncation`, `conversation.item.delete/.truncate`, and summarisation. Claiming the slope is inherent would have been wrong and easily refuted. The real finding is the trade: same dial as cascade, but priced in audio tokens instead of text |
| 21b | **Heap measured primarily in Replay, not Live** | Looping one Recording gives identical input, so any growth is unambiguous; Live's varying utterance lengths mask small leaks. Live retains only the session-scoped check |
| 21c | **Replay pins zero context for both architectures** | A 1-minute clip holds several utterances; without this, Realtime accumulates across them and cascade does not. Closes a confound in Exp 1 that would otherwise be invisible |
| 21d | **`trimmed` = zero context, not a window or the GA auto-parameter** | Zero matches cascade's model exactly and needs no threshold defended. The GA `truncation` parameter chooses what to keep, so a quality change could not be attributed — right for production, wrong as an instrument |
| 21e | **Context policy filed under controllability, not made Experiment 3** | The rubric already requires a controllability section (criterion #8) and names cost per minute as an impact metric. It was an unhomed measurement — the exact "mixed research story" failure the non-pooling rule exists to prevent. It also balances a controllability case that otherwise favours cascade three ways out of three |
| 21f | **Three tiers of control made explicit** | Pinned constant / experimental variable / free exploration. The rule was being applied consistently but never stated, so which settings a user may touch was not legible from the document |
| 22a | **Corpus repackaged: 3 Recordings × ~4 utterances per direction** | Recordings and utterances are decoupled under Replay. Same content and statistical N, a quarter of the runs. Three short takes are far easier to record cleanly and to re-record than one long one — which matters most for the favour being asked of a Spanish-speaking coworker |
| 22b | Categories distributed across recordings, not grouped | Grouping the hard categories would make one recording's aggregate systematically worse and invite false inference. Category analysis comes from per-utterance tags instead |
| 22c | **5 repetitions retained** | ~$4 and ~68 min per full sweep — neither is the constraint. They buy p95, and cascade's three provider hops versus Realtime's one should produce a fatter tail. That is a real architectural consequence p50 hides entirely |
| 22d | **`armTag` derived from configuration; `origin` gates aggregation** | A user-set label can be wrong and would silently corrupt an experiment. Deriving it makes mislabelling impossible. `origin: 'sweep'` is required because only sweep runs had counterbalancing and warmup discard applied |
| 22e | **Retired the "harness aborts on modified triple" guard** | Superseded by 22d. A run with the wrong configuration simply is not an Arm B run — nothing to detect, nothing to abort |
| 22f | **Batch runner exists for control enforcement, not click reduction** | Counterbalancing and warmup discard are requirements a human will apply inconsistently across 45 runs. It is also what makes `origin: 'sweep'` mean something |
| 22g | **Results split into per-experiment primary and per-Recording / per-category secondary** | The aggregate supports claims about architectures; the per-Recording view is navigation and the only place ad-hoc runs are visible; **per-category is where findings actually live**, since recordings were deliberately made homogeneous |
| 22h | §15 rewritten as build status and remaining work | The day-by-day plan described a build that already happened. A fresh agent could not otherwise tell which parts exist |
| 23a | Per-stage selection available in **both** modes | The document said "session header" in one sentence and "Replay configuration panel" in another — leftover from the pre-Replay design. Both modes run cascade, so both need the selector |
| 23b | **Fixtures removed from the selection menu** | Listing a fixture beside two real providers invites a fabricated-output Run into the ledger, contradicting the §8 rule that no reported figure comes from a fixture. Fixtures remain for development, CI, and fault injection |
| 23c | **Voice is a pinned constant, not a menu item** | The register already pins TTS voice per vendor, but the menu selected models and never said which voice. Voice moves fluency scores, so exposing it would make quality figures incomparable |
| 23d | Default panel state is **Arm B's triple** | Unspecified defaults produce orphan runs. Defaulting to the baseline means the untouched state yields comparable data |
| 23e | **Panel displays the derived arm tag live** | Follows from 22d. With membership derived, a user assembling Arm B's triple produces an Arm B run whether or not they meant to — they should see it at configuration time, not discover it in the ledger |
| 23f | MT has two options, not three | The fixture was removed from the menu (23b) and not replaced. STT and TTS carry the same-vendor/cross-vendor pairing; MT gets the cross-vendor contrast only, which is the one the rubric actually asks for |
| 24a | **Playwright retired — the app is the harness** | Playwright with a fake audio device existed because the only audio source was a microphone. Replay feeds a Recording directly through the real client path, so the external driver and its second implementation are unnecessary |
| 24b | **Live stays free-form microphone only — no fixed or looped input** | Two intermediate designs were considered and rejected. Looping a short clip is actively wrong: repeated content drives prompt-cache hits ($0.40/M vs $32/M) and would flatten the very cost slope being measured. A dedicated 5-minute recording fixes that but never exercises the microphone capture path, where audio drift originates — and buys nothing, because the finding is the *shape* of the cost curve, which is a property of the billing model rather than of what was said |
| 24c | Consistency pass — vendor and adapter counts, test list, deliverables, goals, cross-references | Roughly forty edits had left stale counts, a broken §15 reference, orphaned fan-out language, and a benchmark section describing a design that no longer existed |
| 25a | **Runs carry `status`; failed runs are saved but never aggregated, and provenance reports actual N** | A failed run silently included would compute p50 over fewer samples than the provenance claims, with nothing surfacing it. Saving them keeps real information; excluding them keeps the number honest |
| 25b | **Batch runner: visible progress, cancellable, failures retried once then skipped, batch continues** | A 68-minute unattended operation that cannot be cancelled and aborts on the first timeout is unusable. Cancelling yields a short sweep, not a discarded one |
| 25c | **Recording lifecycle: labels editable, deletion soft, corpus Recordings undeletable** | A Run must always be able to reach the input that produced it. Hard-deleting a Recording orphans its Runs and breaks the per-Recording view, so the operation is disallowed rather than warned about |
| 25d | **Blind scoring: on-demand, pairwise, sampled, playback-only, sample size in provenance** | Scoring every pair is unrealistic; a disclosed sample is honest where an implied-complete one is not. Playback-only because showing the transcript would let the Mandarin-pronunciation class of error pass unnoticed |
| 25e | §12 extended to storage and Replay failures | The error table predated the storage layer and covered only live-session and provider failures |
| 15 | TTS interface takes `AsyncIterable<string>` | Shape to the most capable provider; `string` would forfeit ElevenLabs streaming input to match the weakest vendor |
| 16 | Async generators over EventEmitters/streams | Backpressure, `try/catch` propagation, trivially fake-able |
| 17 | Timing/retry/timeout as decorators | Implemented once; a stage cannot be left uninstrumented |
| 18 | Cantonese as the uncommon pair | Author is a native speaker; provider support splits exactly along the axis under test |
| 19 | No fourth vendor for Cantonese | Shopping for a vendor until the answer comes out right is not an experiment |
| 20 | Run Realtime on Cantonese anyway | "Unsupported" is a doc lookup; *how* it fails is the finding |

### Considered and cut
| Cut | Reason |
|---|---|
| WebRTC-to-server for cascade | Jitter buffer adds latency; would make the graded number worse |
| VAD sensitivity sweep (300/500/800) | With VAD pinned, the constant cancels — three parallel lines restating one fact |
| Speculative interim translation | Cannot retract spoken audio; breaks on verb-final languages; multiplies TTS cost |
| DeepL as second MT | API Free/Pro no longer purchasable (July 2026) — procurement risk |
| Claude Haiku as second MT | Contradicted the "MT held constant" control; peer LLMs indistinguishable at this N |
| Azure Speech as fourth vendor | Would stack the deck on the Cantonese question |
| EN↔FR onboarding datapoint | Redundant once Cantonese became config-only — same measurement, unevaluable language |
| LLM-as-judge quality scoring | A scale tool; N=24 is not scale |
| TTS-generated corpus twin | Justified for CI regression, but CI runs on fixtures where audio content is irrelevant |
| Automatic provider failover | Scope; keeps benchmark runs uncontaminated without a flag |
| ECS Fargate + ALB | Config surface and an idle-timeout trap for no benefit at this scale |

---

## 18. Disclosed Limitations

Stated in the write-up rather than left to be discovered:

1. **WER N is small** (~150 reference words/direction) — directional, not precise
2. **Realtime WER is a sidecar measurement** — not what the model translated from
3. **Transport differs between arms** (WebRTC vs WebSocket) — measured separately and reported
4. **Corpus asymmetry** — EN/ES read verbatim, Cantonese improvised
5. **Read speech is cleaner than natural speech** — WER is optimistically biased
6. **Quality judged by one native speaker per language** — n=1 judge
7. **Cantonese quality is audio-only** — no WER
8. **No failover implemented** — resilience differences are analyzed, not demonstrated
9. **Single region, single instance** — no scale or multi-region latency data
10. **Realtime conversation history is lost on mode switch**
11. **Cascade ingest transport is not proven faster than WebRTC** — reasoned, and our own hop is measured, but no head-to-head WebRTC-ingest comparison was built
12. **The cost slope is specific to `gpt-realtime`'s token billing**, not to voice-to-voice generally; `gpt-realtime-translate` is duration-billed and flat
13. **Cantonese is an exploratory track**, never pooled with EN↔ES statistics
14. **Experiment 2 measures a TTS swap only** — it does not generalise to "swapping any provider"; STT and MT provider variation is untested
15. **No ElevenLabs cost figure may be reported** until aggregate-vs-per-chunk billing is verified; the key scope blocked empirical measurement
16. **Replay runs measure replayed audio, not a live conversation.** Replay is paced at 1× through the same transport, but a recorded take cannot reproduce live network jitter or a speaker adapting to what they hear. The 5-minute Live stability run is the only measurement taken under true conversational conditions
17. **Live sessions compare on curve shape, not absolute values.** Each has different unstored speech, so "Realtime climbs, cascade is flat" is supported while precise head-to-head per-minute figures are not. They are never compared against Runs. WER is null in Live
