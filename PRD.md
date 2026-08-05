# AI Interpreter Workbench — PRD

**Realtime API vs. Cascade Pipeline**

> Scope contract: everything in this document will be built. Nothing here is aspirational. Items considered and cut are recorded in §14 with reasoning, not carried as optional scope.

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
1. Both architectures fully working in one browser SPA, switchable mid-conversation
2. A measurement harness whose numbers survive scrutiny
3. Quantified comparison: latency (p50/p95), cost/min, quality, provider flexibility, language-pair onboarding cost
4. A 1–2 page write-up with a scenario-based recommendation

### Non-Goals
- Production-grade scale, auth, multi-tenancy, or session persistence
- Beating either architecture's published benchmarks
- Exhaustive language coverage
- Automatic provider failover (see §14, Cut 5)

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
| **C** | Deepgram Nova-3 STT → `gpt-4o-mini` → ElevenLabs Flash v2.5 TTS |

**MT is deliberately held constant across B and C** so the measured delta isolates the STT/TTS swap. Answers the "provider flexibility" and "time-to-onboard" metrics, which are structurally unmeasurable in Arm A.

### Track 3 — Cantonese: an exploratory case study, not an experiment
Coverage, pronunciation, transcript auditability, and failure mode on an uncommon pair. Qualitative, single native evaluator, no verified written reference. See §10.

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
- **16 kHz up** (native STT input rate), **24 kHz down** (TTS output)
- 20 ms chunks
- No Opus encode/decode — raw PCM avoids codec latency; all target STT providers accept linear16 natively

**WebRTC-to-server was rejected on the merits, not difficulty.** WebRTC ingest requires a jitter buffer (deliberately buffering 40–100 ms to smooth packet arrival) plus Opus transcode, which on a stable connection should measure *slower* than raw WebSocket PCM.

**This is stated as a hypothesis, not a premise.** It is a reasoned expectation, not a measured result, and the write-up says so. The transport hop is instrumented separately (§7), so the actual cost of our ingest path is reported as a number rather than asserted. We do not claim WebSocket PCM is categorically faster than WebRTC — only that we measured ours.

**Disclosed consequence:** the two arms use different transports. This is measured (§7) and stated in the write-up, along with the observation that production cascade over consumer networks *would* need WebRTC ingest — a cost the Realtime path absorbs invisibly inside OpenAI's own transport.

---

## 5. Providers

**Three vendors. Seven adapters.**

| Stage | Arm B (control) | Arm C (best-of-breed) | Test |
|---|---|---|---|
| **STT** | `gpt-4o-transcribe` | **Deepgram Nova-3** | Fixture |
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
| Deepgram Nova-3 (streaming, multilingual) | $0.0092/min |
| ElevenLabs Flash v2.5 | $0.05 / 1k chars |

### The cost slope is a billing-model property, not an architecture property

Verified against OpenAI's costs guide: *"The entire conversation is sent to the model for each Response… turns later in the session will be more expensive."* `gpt-realtime` is token-billed with conversation replay, so cost per minute **rises across a session** (§7 stability).

But `gpt-realtime-translate` — OpenAI's purpose-built streaming speech-translation model — is **billed by audio duration at $0.034/min, not by tokens.** Flat, no slope, regardless of session length.

That sharpens the finding rather than weakening it:

> The cost slope is not inherent to voice-to-voice. It is a property of `gpt-realtime`'s token billing with conversation replay. The purpose-built translation model removes it entirely by changing the billing basis — at the cost of 13 output languages and no voice selection. Cascade remains cheaper still at ~$0.021/min, with broader language reach.

**Scope:** the rubric requires `gpt-realtime`, so that is Arm A. `gpt-realtime-translate` is measured as a **cost and coverage datapoint**, not a fourth arm — one short run to confirm the published rate and its language list.

**Known cost trap:** ElevenLabs bills a 1,000-character minimum per request. Because cascade streams text in chunks, aggregate-vs-per-chunk billing must be verified before any Arm C cost figure is reported.

---

## 6. Architecture

### Two levels of abstraction — kept distinct

**Mode level** — the UI renders one column per active arm and cannot tell what any of them are:

```
[mic] → [capture] → [ArmRouter] ──→ RealtimeTransport   (WebRTC → OpenAI)
                    (fan-out)   ──→ CascadeTransport    (WebSocket → server, Arm B)
                                └─→ CascadeTransport    (WebSocket → server, Arm C)

interface InterpreterTransport {
  start() · stop() · sendAudio(pcm)
  events: onSourceText · onTargetText · onAudio · onStageTiming
}
```

**The router fans out rather than switches.** The same microphone audio feeds every active arm simultaneously, so a live comparison is guaranteed to be over identical input — something sequential runs can never achieve, since a human says the sentence differently the second time. Arms are opt-in; the UI shows each arm's added cost per minute before it is enabled.

This is a stronger demonstration of the transport abstraction than a toggle: the UI does not know how many arms exist, only that each satisfies `InterpreterTransport`.

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
const stt = withTiming('stt', withRetry(withTimeout(new DeepgramStt(cfg), 5000)))
```

Instrumentation and resilience are implemented once and applied uniformly. Adapters stay thin — protocol translation only. A stage cannot be accidentally left uninstrumented.

### Provider selection is config-driven

```ts
const stt = createStt(cfg.stt.provider, cfg.stt.options)
```

- Adding a **language pair** → config entry
- Adding a **provider** → one adapter file + one registry line

### Playback, autoplay, and language switching

**The app opens in single-arm live mode with autoplay on.** One arm active, a literal Realtime/Cascade segmented toggle, immediate translated audio — voice in, voice out, switchable mid-session. This is what a reviewer sees within seconds of opening the app, and it is the configuration the rubric's must-haves #2 and #4 and the 5-minute stability benchmark are written against.

**Comparison mode is one click away.** Enabling a second arm fans out the same audio to both and turns autoplay off, because two arms would talk over each other.

**In comparison mode nothing autoplays.** Every arm buffers its audio and reports a `ready` state; the user plays each on demand. This removes audio collision by construction rather than by arbitration, and makes A/B listening deliberate instead of a memory test.

Per-arm states rendered in the UI:

| State | Cascade | Realtime |
|---|---|---|
| in flight | live per-stage progress, 5 intervals | one progress bar, no stage detail |
| ready | transcript, play button, **labelled ms per interval**, total, cost | same, 3 intervals, model interval labelled opaque |
| failed | which stage failed, session continues | opaque failure, session continues |

- Microphone captured **once**; PCM fanned out to every active transport. No re-permission prompt.
- **Autoplay is a setting, default off, and is only enabled when exactly one arm is active** — two arms would talk over each other. With one arm plus autoplay, the workbench is a live interpreter. **This is the configuration used for the 5-minute back-and-forth stability run**, and it satisfies rubric must-have #2 ("voice in, voice out") and the conversational stability benchmark.
- The mode toggle selects **which arm is active**, switchable mid-session, satisfying rubric must-have #4.
- A switch requested mid-utterance **queues and applies at the next utterance boundary**. Audio is never cut mid-stream.
- **Language pair is selectable in-session**, same queue-at-boundary mechanism.
- Transcript history, language pair, and latency log live above the transport and survive any switch.

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

**Measurement note:** "first audio out" is timestamped when the first audio sample is decoded and queued for playback — the exact instant it would begin sounding if autoplay were on. On-demand playback does not move that timestamp, and the write-up states this explicitly since the rubric's wording is "perceived latency."
- **Language pair is selectable in-session**, not only pre-session, using the identical queue-at-boundary mechanism. One mechanism, two triggers.
- **Direction swap is a dedicated control** (EN→ES ⇄ ES→EN) rather than a dropdown re-selection, since both directions are measured arms run repeatedly.
- The language menu **labels support per pair** — "both modes" or "cascade only" — surfacing the architectural limitation in the product's own navigation.
- **Support is a property of a direction, not of a pair.** EN→YUE and YUE→EN are separate claims: the first depends on Realtime *producing* Cantonese, the second on it *recognising* Cantonese. The unsupported-output warning fires only when the **target** is Cantonese. The pair-level support pill ("cascade only") is labelled by its most constrained direction, so the pill and the warning can legitimately disagree — the write-up reports coverage per direction.
- Selecting a pair the Realtime model does not list **warns but does not block.** Blocking would prevent the observation the experiment wants: what it actually does. The target pane additionally carries a "text looks correct — audio pronunciation may not be" callout, surfacing the Mandarin-pronunciation trap in the product itself.
- **Disclosed:** Realtime conversation history is held server-side by OpenAI and is lost on switch. Minor for interpretation (utterances translate independently) but affects pronoun/gender resolution.

---

## 7. Measurement Methodology

### Endpointing — pinned across arms
Voice activity detection silence threshold is **pinned to 500 ms in every arm** (`turn_detection.server_vad.silence_duration_ms` for Realtime; Deepgram `endpointing` for cascade).

Endpointing is roughly half the perceived-latency budget and is a pure config dial. Left at provider defaults, the measured architectural gap could be mostly VAD configuration — an invalidation that would be invisible in the data.

**No sensitivity sweep.** With VAD pinned identically, the threshold is a constant added to both arms and cancels in the difference. Sweeping would produce parallel lines restating the constant.

**Instead — VAD offset validity check.** Because the corpus is pre-recorded, true speech-end is computed offline for every clip. We measure `VAD_fire_time − true_speech_end` per arm. If both land near 500 ms the control held; if they diverge (different VAD algorithms), the difference is reported and subtracted.

### Segmentation — "final" defined precisely

Streaming STT emits two different things both commonly called "final," and conflating them changes latency materially:

| Signal | Meaning | Used? |
|---|---|---|
| `is_final` / stable segment | this *segment* won't be revised; more may follow in the same turn | **no** |
| `speech_final` / endpoint | the speaker's **turn** is complete, after the pinned 500ms silence | **yes — this is our trigger** |

**We translate on turn-final only.** A long sentence produces one translation, not several. Clause-level commit was considered and cut (§16) — it lowers latency but requires revision handling across segment boundaries and breaks on verb-final languages.

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
- **Realtime** — client-timestamped API events: `speech_stopped` → `response.created` → first `response.audio.delta`.

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
| endpointing | `speech_end` → `server_speech_stopped` |
| model | `server_speech_stopped` → `first_audio_delta` — **opaque, explicitly labelled** |
| queue | `first_audio_delta` → `audio_queued` |

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

**One ledger under every view.** All four screens read from a single append-only run ledger of utterance records (§7) grouped by run and experiment. Curated screens sit *above* it; the ledger is the source of truth, so a metric cannot drift between screens or between a screen and the write-up. Every run row carries its configuration, pair, providers, thresholds, errors, evaluator method, and provenance.

**Empty states are mandatory.** A results card renders "no runs recorded" until real data exists. Sample figures anywhere — including `wireframes.html` — are labelled **illustrative** at card level, so polished placeholders can never be mistaken for measured evidence.

Three result screens, each titled with its research question rather than a generic dashboard label:

| Screen | Content |
|---|---|
| **Does the architecture itself cost latency?** | Exp 1 — Arm A vs Arm B: p50, p95, cost/min, WER, adequacy, fluency, observable stage count |
| **What does swapping providers buy?** | Exp 2 — Arm B vs Arm C: p50, cost/min, WER, fluency |
| **Provider flexibility** | Per-pair coverage broken out **by stage** (realtime / STT / MT / TTS), so a failure is attributable to a specific stage rather than the pair as a whole. Per-cell expandable observation notes for qualitative findings a matrix can't hold. Time-to-add a language pair and a provider, **each citing commit hash and diff size**, plus the realtime equivalent (no mechanism at any price) |
| **What changes as the conversation continues?** | Stability run, per arm — see below |

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

**Method:** Playwright loops the corpus for 5 minutes in **single-arm autoplay mode**, once per arm. Reconnects and per-utterance latency instrumented continuously; CDP heap snapshots at start and end, diffed. Separately, a **60-minute fixture-provider run overnight** for leak detection — free, and where leaks actually surface.

### Benchmark harness
**Playwright driving the real SPA in Chrome**, with `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture`.

Both arms are measured through the **identical browser path**. A Node-side harness could not exercise Realtime's browser→OpenAI WebRTC path and would reintroduce the transport confound.

- **5 repetitions** per utterance per arm → 60 samples/arm → **p50 and p95**
- **Arms run one at a time during sweeps**, never concurrently. Live side-by-side is for observation; concurrent streams contend for network and CPU, and the effects being measured are ~100ms. Live view is for seeing, sweeps are for measuring.
- Results emitted as JSON, consumed by both offline analysis and the in-app results view
- **Failover disabled** (not implemented, §14)
- Estimated full sweep: ~45 min audio, **~$3.40**

### Fixtures — hard rule
Fixture providers replay canned output on configurable timers with fault injection. They are used for development, CI, error-path tests, and long-running stability runs.

> **No number reported in the write-up may come from a fixture run.** Fixture latency is a configured constant. Every latency, cost, and quality figure comes from real providers on real audio.

---

## 8. Corpus

**36 clips total, ~4 minutes of audio, committed to the repo with reference material.**

| Set | Count | Method | Reference | WER? |
|---|---|---|---|---|
| **English** | 12 | Self-recorded, **read verbatim** | Written script | ✅ |
| **Spanish** | 12 | Coworker, **read verbatim from written script** | Written script | ✅ |
| **Cantonese** | 12 | Self-recorded, **improvised from English prompt cards** | Corresponding English utterance (meaning) | ❌ |

**Format:** 16 kHz mono WAV PCM16 (matches transport — no resampling in the measured path).

**Six categories, 2 each** — chosen because the architectures diverge here, not on clean sentences:
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

## 9. Quality Measurement

### WER — reported honestly, with scope
- **Cascade (Arms B, C):** WER on the STT transcript. Valid — this transcript is the actual pipeline input.
- **Realtime (Arm A):** reported **explicitly labeled as a sidecar measurement.**

**Why the label matters.** Realtime produces no source transcript as a byproduct. Satisfying the "show source text" requirement forces enabling `input_audio_transcription`, which runs **a separate STT model in parallel** (~$0.006/min on top of Realtime's higher rate). That transcript is a second model's guess about the audio — **not what the model translated from.** They can disagree.

This yields a core finding: **cascade's transcript is auditable — it *is* what got translated, and a wrong output can be traced to a stage. Realtime's is not.** For medical and legal interpretation, that is a compliance and liability question, not a technical footnote.

**Disclosed limitation:** ~150 reference words per direction. One misrecognized word moves WER ~0.7pp. Adequate for detecting large gaps, **reported as directional, not precise.**

### Translation quality — blind human scoring, built into the app

Because nothing autoplays, blind comparison is a natural feature rather than an offline chore. **"Compare blind" hides arm identity**, presents the outputs as Sample A and Sample B in randomized order, and asks for a **1–5 rating on adequacy and fluency**. Identity is revealed after submission, and scores append to the results view.

**Randomization is per comparison, not a fixed swap**, and the drawn assignment is **persisted to the run ledger** alongside the score. A fixed A↔B inversion would teach the evaluator the mapping after a single reveal; persisting the draw is what makes the blinding auditable after the fact rather than merely asserted.

- **Spanish** — scored in-app by the Spanish-speaking coworker
- **Cantonese** — scored in-app by the author (native speaker)
- Plus the author's listening notes on prosody, naturalness, number/proper-noun survival, and disfluency handling

Blind scoring by native speakers is used rather than an LLM judge: at N=24 this is more credible and costs nothing. Building it into the product removes the spreadsheet step and guarantees the ordering was actually randomized.

### Cantonese — audio-first, no WER
Evaluated **by ear**, both directions. Stated plainly in the write-up: *quality assessed by ear by a native speaker; WER not computed for lack of a verified written reference.*

**Specific check:** written Cantonese shares most characters with Mandarin. A TTS that does not distinguish the spoken languages will read Cantonese text aloud **in Mandarin** — output that looks correct in the transcript and is wrong in the audio. **A text-only evaluation scores this as a success.** Detectable only by listening, and only by a speaker.

---

## 10. Language Pairs

| Pair | Scope |
|---|---|
| **EN ↔ ES** | Fully measured — latency, WER, quality, cost |
| **EN ↔ YUE (Cantonese)** | Measured audio-first, both directions, no WER |

**Cantonese as the uncommon-pair test.** Provider support splits along the exact line under test:

- **Deepgram Nova-3** — Cantonese Traditional supported
- **ElevenLabs** — Cantonese STT confirmed; **TTS coverage to be verified before build** (§13, Day 1)
- **OpenAI Realtime** — Cantonese **not listed** among supported output languages

**No fourth vendor will be added to make Cantonese work.** Testing it against the vendor set already chosen for Spanish is the honest experiment; shopping for a vendor until the answer comes out right is not.

Whichever way ElevenLabs coverage lands, the result is reportable:

| Outcome | Finding |
|---|---|
| Flash v2.5 covers Cantonese | Cascade delivers a language Realtime cannot |
| Only a slower model covers it | Uncommon languages cost latency too |
| No coverage | Cascade localizes the gap to **one stage**; Realtime fails opaquely. **Flexibility ≠ coverage.** |

**Realtime is run on Cantonese regardless** (~10 min, ~$0.50) to document the actual failure mode. "Unsupported" is a documentation lookup, not a finding; *how* it fails is the finding — and if it produces fluent-sounding Mandarin, that is decisive evidence for the auditability argument and detectable only by a native speaker.

**Onboarding cost is proven by commit**, not claimed: the diff and elapsed time for adding EN↔YUE are recorded.

---

## 11. Error Handling

**Graceful failure. No automatic failover.**

| Failure | Behavior |
|---|---|
| Mic permission denied | Clear UI message; app remains usable |
| Provider timeout | Abort via `AbortSignal`; fail the utterance; session survives |
| Rate limit (429) | Retry with backoff; then surface a clear error |
| Empty / null result | Skip utterance, log, do not crash the pipeline |
| WebSocket drop | Auto-reconnect with session state preserved |
| Provider hard failure | Surface clearly in the UI; session survives |

**Failure messages are architecture-differentiated, and that is a finding.** Cascade can name the stage that failed; Realtime cannot:

- Cascade — *"mt stage timed out for this utterance — session still running"*
- Realtime — *"opaque failure — no stage attribution · session still running"*

The auditability gap does not only appear in the happy path's timing breakdown. It appears again, and more sharply, at the moment something breaks — which is exactly when an operator needs attribution. Worth one line in the write-up.

All implemented via the `withRetry` / `withTimeout` decorators — once, applied uniformly.

*The write-up may note as analysis that cascade has a fallback path available and Realtime structurally does not. It will not imply failover was built.*

---

## 12. Testing

**Vitest. All tests run against fixtures — deterministic, fast, zero API spend, CI-safe.**

| # | Test | Purpose |
|---|---|---|
| 1 | **Contract tests** — one shared suite run against *every* implementation of each interface | Proves "swapping a provider is a contained change." A new provider is interchangeable iff it passes. |
| 2 | **Streaming assertion** — first TTS byte arrives before MT finishes emitting tokens | Encodes the "no full-utterance blocking" requirement as an executable check |
| 3 | **Error paths** — fixture injects timeout / 429 / empty result | Session survives; failure surfaces |
| 4 | **Cancellation** — `AbortSignal` mid-stream | No leaked sockets or timers; protects stability benchmark and mode switching |
| 5 | **Instrumentation validation** — fixture with known 200 ms delay measures ~200 ms | **The entire thesis rests on the timing code being correct.** Nothing else would catch a bug here. |

| 6 | **Turn-final mapping** — each STT adapter's turn-final signal maps to `SttEvent.type === 'final'` | Prevents "final" silently meaning segment-final in one adapter and turn-final in another (§7) |

**Plus one real-provider smoke test per path**, run manually, not in CI. Fixtures prove orchestration; they cannot prove a provider still behaves as its adapter assumes. Each path gets one live call asserting a non-empty, well-formed response.

**Not tested:** UI components, provider SDK internals, live network calls in CI.

---

## 13. Deployment & Cost Control

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
| Deepgram $200 free credit | Arm C STT effectively free |

**Projected total: $30–50.**

---

## 14. Build Sequence

Working app on day 1 with fixtures; every subsequent step swaps one fixture for one real provider.

| Day | Work | Milestone |
|---|---|---|
| **0** | **Provider preflight — before any interface is frozen.** Pin the exact realtime model id and endpoint from the live catalog; confirm the transport, audio format, and the event names in §7 against a real session; confirm `gpt-4o-mini-tts` availability; verify Deepgram's turn-final signal name; verify ElevenLabs Cantonese TTS coverage and whether streaming input bills on aggregate or per chunk; re-read all published rates; provision every key. Then run **one real voice-in/voice-out spike through each architecture** — throwaway code, no abstractions. | Assumptions replaced with observations |
| **1** | Repo, Vitest, 4 interfaces, all fixtures, cascade skeleton, UI shell (session cockpit, transcripts, labelled per-stage latency, mode toggle) | App runs end-to-end, $0 spent |
| **2** | Arm B adapters (OpenAI STT/MT/TTS), real streaming, timing decorators | First real latency numbers |
| **3** | Realtime mode — ephemeral token endpoint, browser WebRTC, both transcripts, mid-session toggle | **Both arms live** |
| **4** | Record corpus (self + coworker). Playwright harness, offline speech-end extraction, benchmark runner, instrumentation validation test | Reproducible measurement |
| **5** | Arm C adapters (Deepgram, ElevenLabs). Contract tests across all implementations | Experiment 2 ready |
| **6** | Graceful failure paths, reconnect, blind-compare UI, stability: 60-min fixture soak overnight + one 5-min real run **per arm** in single-arm autoplay mode | Stability measured, both arms |
| **6.5** | Deploy — EC2 + Caddy | Live URL |
| **7** | Cantonese: record 12 clips, EN↔YUE config, cascade runs, document Realtime failure mode | Uncommon-pair finding |
| **8** | Full sweeps (all arms, 5 reps, run sequentially), WER, blind scoring, cost model | All data collected |
| **9** | In-app results view — four screens, wired to the sweep JSON | Results are clickable |
| **10–11** | Comparison write-up, README, AGENTS.md | Docs complete |
| **12–14** | **Buffer** | — |

### Process rules
- **Commit continuously**, scoped to logical units. The sequence above produces natural commit boundaries. Git history reflecting iterative development is graded and cannot be reconstructed afterward.
- **AGENTS.md written from day 1**, accreted live — actual instructions that worked, corrections made, places the agent was overridden. Written from memory on day 10 it would be vague and partly invented.

---

## 15. Deliverables

1. **Browser SPA** — mic capture, **side-by-side arms on shared audio with on-demand playback per arm**, blind-compare scoring, autoplay single-arm mode, in-session language pair switcher with direction swap and per-mode support labels, live source+target transcripts, per-stage latency display
1b. **In-app results view** — four screens covering Experiment 1, Experiment 2, provider flexibility, and stability-over-time, each with provenance
2. **Node/TS backend** — ephemeral token endpoint, cascade orchestrator, provider adapters
3. **Benchmark harness** — Playwright runner, corpus, analysis scripts, results JSON
4. **Test suite** — Vitest, five categories per §12
5. **Corpus** — 36 clips with reference material
6. **Comparison write-up** — 1–2 pages: latency, quality, cost, controllability, scenario-based recommendation
7. **README** — setup, run, architecture
8. **AGENTS.md** — how the coding agent was directed
9. **Deployed instance** — EC2 + Caddy

---

## 16. Decision Log

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
| 11 | Playwright, not a Node harness | Only way both arms traverse the identical browser path |
| 12 | Fixtures never produce reported numbers | Fixture latency is a configured constant |
| 13 | Blind human scoring, not LLM judge | At N=24, native-speaker blind scoring is more credible and free |
| 14 | Mid-session toggle | Forces the graded transport/UI separation; best demo moment |
| 14b | In-session language switching, same boundary rule | Cantonese and Spanish arms are run back to back; restart-per-pair would add friction to every measurement run. Reuses the mode-switch mechanism rather than introducing a second concept |
| 14c | Unsupported-language warning does not block | Blocking would prevent the observation the experiment exists to make |
| 14d | Router fans out to all arms simultaneously | The product is a comparison workbench. Showing one arm at a time makes comparison a memory test, and sequential live runs can never use identical input |
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
| 15d | Canonical timing vocabulary + single utterance record | UI, harness, tests, and write-up previously risked four definitions. Also resolved a real §6/§7 inconsistency: Realtime has 3 intervals, not 2 |
| 15e | Per-stage latency shown as **labelled milliseconds** | Rubric requires per-stage latency visible to the user. Proportional bars and a "stages seen" count do not satisfy it |
| 15f | "Final" defined as **turn-final**, asserted per adapter | The term was ambiguous between stable-segment and end-of-turn; the two differ materially in latency |
| 15g | One run ledger beneath all result views; mandatory empty states | Prevents metric drift between screens and the write-up; stops polished placeholders reading as measured evidence |
| 15h | Day-0 provider preflight before freezing interfaces | API churn is the largest external risk. Preflight also revealed `gpt-realtime-translate` is duration-billed, which reframes the cost-slope finding |
| 15i | WebSocket-vs-WebRTC restated as a hypothesis | It was reasoned, not measured. The transport hop is instrumented and reported as a number instead |
| 16a | Failure copy differentiated by architecture | Cascade names the failed stage; Realtime cannot. The auditability gap reappears at the moment attribution matters most |
| 16b | Blind draw randomized per comparison and persisted to the ledger | A fixed A↔B swap stops being blind after one reveal; persisting the draw makes the blinding auditable |
| 16c | Language support labelled per direction | EN→YUE and YUE→EN are different claims — producing Cantonese versus recognising it |
| 16d | Mic permission specified as a four-value property, **design delegated** | It is one small indicator plus one blocking case, not a screen worth reworking the handoff for. The functional constraints — no re-prompt after denial, two independent blocking layers — are what actually determine correctness |
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

## 17. Disclosed Limitations

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
