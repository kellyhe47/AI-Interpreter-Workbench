# RUN_LOG — overnight autonomous build

Run started: 2026-08-04 ~23:00 local. Operator asleep; instructions: build Arms A + B fully,
ElevenLabs TTS adapter (not an arm), fixtures everywhere, $5 hard cap, preflight → TDD build →
QA loop until convergence.

## Budget ledger (hard cap $5.00)

| When | What | Est. cost |
|---|---|---|
| 08-04 23:30 | Preflight: gpt-4o-mini-tts input clip (78 chars) | ~$0.001 |
| 08-04 23:35 | Preflight: gpt-realtime-mini spike (79 in / 134 out tokens) | ~$0.003 |
| 08-04 23:40 | Preflight: gpt-4o-transcribe spike ×2 (1 rejected free, 1 run) | ~$0.001 |
| 08-04 23:45 | Preflight: gpt-4o-mini MT spike (58 tokens) | ~$0.0001 |
| 08-04 23:45 | Preflight: ElevenLabs Flash v2.5 WS (79 chars, quota not $) | ~$0.004 equiv |
| | **Running total (OpenAI $)** | **~$0.005** |

## 2026-08-04 23:00 — Kickoff

- Read PRD.md, design handoff README, dc.html mock source, all token CSS, rubric PDF.
- Scope confirmed: Arms A (Realtime WebRTC) + B (OpenAI cascade), fixture providers for every
  stage, ElevenLabs TTS as second real TTS provider (validates AsyncIterable<string> streaming
  input), no Deepgram adapter, no Arm C composition.
- Keys present in .env: OPENAI_API_KEY, ELEVENLABS_API_KEY, ANTHROPIC_API_KEY.
- Plan: Phase 1 preflight (docs checks free → 2 throwaway spikes + ElevenLabs smoke),
  Phase 2 /tdd-orchestrator against PRD, Phase 3 /manual-qa loop to convergence.

## 2026-08-04 23:20 — Preflight: docs verification (free, no spend)

**Realtime (Arm A):**
- Ephemeral token: POST `https://api.openai.com/v1/realtime/client_secrets`, body
  `{session: {type:"realtime", model, audio:{output:{voice}}}}`. SDP exchange: POST
  `https://api.openai.com/v1/realtime/calls` with `Authorization: Bearer <ephemeral>`,
  `Content-Type: application/sdp`. Events over `oai-events` data channel. Matches PRD §4.
- GA event names (changed from beta — PRD §7 wrote `response.audio.delta`, GA is
  **`response.output_audio.delta`**): `input_audio_buffer.speech_started/.speech_stopped`,
  `response.created/.done`, `response.output_audio.delta`, `response.output_audio_transcript.delta`,
  `conversation.item.input_audio_transcription.delta/.completed`. **Deviation logged:** adapters
  use GA names.
- Turn detection GA shape: `session.audio.input.turn_detection = {type:"server_vad",
  silence_duration_ms: 500, ...}` — PRD's pinned 500 ms is expressible. ✓
- Docs reference `gpt-realtime-2.1` as current snapshot; `gpt-realtime` / `gpt-realtime-mini`
  aliases to be confirmed live in spike.

**Cascade (Arm B):**
- Transcription over realtime WS: session `{type:"transcription", audio:{input:{format:
  {type:"audio/pcm", rate:24000}, transcription:{model}, turn_detection}}}`. Docs now push
  `gpt-live-transcribe` ($0.017/min); **`gpt-4o-transcribe` still listed at $0.006/min** — PRD's
  pick stands, spike confirms it's accepted in a transcription session.
- Docs show 24 kHz PCM for transcription input; PRD §4 says 16 kHz up. Spike tests 16k
  acceptance; if 24k-only, capture at 24 kHz mono up (deviation, minor bandwidth cost).
- TTS: POST `/v1/audio/speech`, `gpt-4o-mini-tts`, `response_format:"pcm"` = raw 24 kHz s16le,
  chunked-transfer streaming. Matches PRD (24 kHz down). ✓
- MT: `gpt-4o-mini` chat completions streaming. ✓

**ElevenLabs:**
- WS `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?model_id=eleven_flash_v2_5`,
  init msg `{text:" ", voice_settings, generation_config:{chunk_length_schedule}}`, chunks
  `{text}`, flush `{text:"", flush:true}` — close `{text:""}`. Audio back as base64 +
  `isFinal`. `output_format` query param exists; pcm option list not documented — smoke test
  will request `pcm_24000` and verify.
- **Billing aggregate-vs-per-chunk is not documented anywhere.** Will determine empirically:
  read `/v1/user/subscription` character_count before/after a 3-chunk streamed synthesis.

**Pricing re-verified (all match PRD §5):** gpt-realtime $32/$64 per M audio tokens;
gpt-realtime-mini $10/$20; gpt-realtime-translate $0.034/min; gpt-4o-transcribe $0.006/min;
gpt-4o-mini $0.15/$0.60 per M; gpt-4o-mini-tts $12/M audio-out tokens.

## 2026-08-04 23:45 — Preflight: live spikes (throwaway code in scratchpad, not committed)

All four paths verified with real calls:

1. **gpt-4o-mini-tts** — `response_format:"pcm"` chunked streaming works; 4.4 s clip, first
   byte 1.24 s cold. This clip became the spike input audio.
2. **Realtime, `gpt-realtime-mini` over WS** — alias accepted. GA session shape + server_vad
   silence_duration_ms:500 accepted. Perfect ES translation of the clip. Event names observed
   live exactly as docs: `input_audio_buffer.speech_started/stopped/committed`,
   `response.created`, `response.output_audio.delta` (13), `response.output_audio_transcript.delta`,
   `response.done` w/ usage. Model interval (speech_stopped→first audio delta): 602 ms.
3. **Transcription session, `gpt-4o-transcribe`** — accepted (PRD's model pick stands despite
   docs now promoting gpt-live-transcribe). **16 kHz input rejected**:
   `integer_below_min_value … Expected >= 24000`. → **Deviation: transport is 24 kHz PCM16 up**
   (PRD §4 said 16 kHz). 24 kHz run: perfect transcript, 15 partial deltas, turn-final via
   `…input_audio_transcription.completed`, stt interval 994 ms.
4. **ElevenLabs `eleven_flash_v2_5` stream-input WS** — `output_format=pcm_24000` works; text
   sent as 3 timed chunks (validates AsyncIterable<string> input shape); first audio 387 ms
   after connect; 4.88 s Spanish audio out.

**Blocker (needs operator): ElevenLabs aggregate-vs-per-chunk billing could not be verified
empirically.** The API key is TTS-scoped only — `/v1/user/subscription` and `/v1/history` both
401 (`missing_permissions: user_read / speech_history_read`). Docs don't state the answer
either. Until verified (dashboard usage view, or re-scope the key), no ElevenLabs cost figure
may be reported; the adapter is built and smoke-tested regardless. Logged per PRD §5 known
cost trap.

**Interface freeze:** with the above observed, PRD §6 interfaces freeze as written, with the
single amendment that the pipeline sample rate is 24 kHz end-to-end (up and down).

## 2026-08-05 00:00 — Phase 2: TDD build started (/tdd-orchestrator)

- Scaffolded Vite+React+TS client / Express+ws server / Vitest (node + jsdom) — probes verified,
  committed. One infra correction along the way: tsconfig.server.json initially used NodeNext
  resolution, which demands `.js` import extensions the codebase doesn't use; switched server
  typecheck to bundler resolution + tsx-run-in-prod. Logged since it changed `npm start`.
- Decomposed into 15 tickets (.tdd/tickets/): core interfaces+fixtures+decorators+contracts
  (001–003), server cascade+transport (004–005), OpenAI adapters (006), ElevenLabs adapter
  (007), session FSM (008), ledger (009), client audio (010), client transports (011), session
  view (012), results view (013), blind compare (014), corpus+harness (015).
- **001–003 green in 1 iteration** (61 tests). Locked-test discipline held.
- Wave W1 dispatched: 3 parallel worktrees — server (004+005), adapters (006+007), client
  state (008+009). Note: W1-A's test-writer owns reconciling protocol.ts with PRD §4 binary
  audio frames (the initial core protocol draft used base64 JSON for upstream audio).

## 2026-08-05 ~01:00 — Wave W1 complete: 9/15 tickets green, all in 1 iteration

- 004–005 (cascade orchestrator + WS transport + token endpoint), 006–007 (OpenAI + ElevenLabs
  adapters), 008–009 (session FSM + ledger) all green, merged to main. Full suite on main:
  **246 tests passing.** Locked-test discipline held in every batch; one implementer needed an
  internal iteration (ElevenLabs interleave — fixed with consumer-paced backpressure, not by
  touching tests). Protocol revised: binary PCM both directions, downstream frames carry a
  4-byte LE utterance header.
- Live probe on the server surface: booted real server, real WS client, fixture cascade —
  stt.partial×2 → stt.final → mt.delta×2 → mt.final → binary TTS frames → utterance.complete. ✓
- **Real smoke through the merged adapters** (operator-authorized one-per-path):
  MT "Buenos días…" ✓; OpenAI TTS 1.65 s PCM ✓; ElevenLabs streaming-input adapter 2.51 s PCM,
  **first-audio 318 ms** ✓ — AsyncIterable<string> streaming input works against the real API
  through the production adapter (PRD §6 decision 15 validated end-to-end). ~$0.003 added.
- Swappability proof now real: OpenAI TTS, ElevenLabs TTS, and FixtureTts all pass the ONE
  shared contract suite unchanged.
- Next: B2 (client audio + transports, main dir) ∥ 013 (results view, worktree).

## 2026-08-05 ~02:30 — Tickets 010–013, 015 green; 012 (session view) green

- 010–011 (client audio + transports/router), 013 (results view), 015 (placeholder corpus:
  36 synthetic WAVs + manifest, fixture bench harness writing PLACEHOLDER-tagged records),
  and 012 (session view cockpit + App shell) all green, all in ≤1 visible iteration. Suite:
  **433 tests, 32 files.** `vite build` clean.
- Placeholder corpus records verified excluded from ledger aggregation (isRealRecord false) —
  the results view stays on its empty state, per the no-fixture-numbers rule.
- **Integration gap flagged by 012's implementer (to fix before QA): production browserDeps
  does not attach the mic MediaStream track to the Realtime RTCPeerConnection** — Arm A
  voice-in would silently fail in a real browser. Test-level fakes couldn't catch this
  (untested production path by design). Scheduled into the 014 implementation dispatch.
- 014 (blind compare) test-writing dispatched — reusing the 012 test-writer agent for context
  continuity (same files, same kit).

## 2026-08-05 ~03:30 — Build complete; integration; QA iteration 1; soak

- **All 15 tickets green. 438 tests / 33 files. vite build + prod boot verified.**
- Integration fixes: prod static serving was missing (added, PRD §13 single origin); 012's
  implementer had flagged that browserDeps never attached the mic track to the Realtime
  RTCPeerConnection — fixed additively in the 014 dispatch (getMediaStream seam + addTrack
  before createOffer; recvonly transceiver fallback). Unit-untestable, exercised by QA.
- AWS credentials absent → **deploy skipped, verified locally** (per operator instruction).
- **Fixture stability soak: 8.5 min, 53,178 utterances through the real server WS + cascade
  orchestrator, 0 errors, heap 12.3 → 13.0 MB flat with forced GC — no leak signal.**
  (PLACEHOLDER-tagged output in benchmark-results/fixture-soak.json; 45-min run was cut to
  8.5 min by the background-command timeout cap — rerun overnight-length soak is an operator
  option, the flat curve at 53k utterances is already a strong signal.)
- **QA iteration 1** (browser pane, real dev servers): flows walked = idle/results-empty,
  deny path (real NotAllowedError — blocking card + four-value indicator correct), language/
  direction warnings (exact copy), instant sessionless switches. Zero console errors.
  Findings filed: 016 elapsed timer ticks in permission-denied (bug), 017 default mode is
  Cascade but mock says Realtime (visual-spec deviation), 018 no browser-drivable fixture mode
  (blocks QA of all live-session journeys + future Playwright harness). Mic-grant journeys
  escalated: the pane hard-blocks capture; 018 unblocks them next iteration.

## 2026-08-05 ~05:30 — QA loop iterations 2–6: CONVERGED

- **Iter 2** (after 016–018 fixed via the TDD loop, 454 tests): the three fixes verified
  in-browser; fixture mode drives every previously-halted journey. New findings: **019 queued
  switch never applies** (banner stuck through boundaries — the significant bug of the night),
  020 stale arm-card content, 021 fixture script exhaustion wedges 'processing'.
- **Fix batch 019–021** (459 tests): switch semantics corrected to apply-immediately-at-
  boundary / queue-only-in-flight; per-utterance arm-card reset; looping fixture scripts. The
  implementer also caught live that a swapped-in transport restarted utterance numbering and
  silently never opened its first utterance — fixed with a counter reset on arm swap.
- **Iter 3: clean pass.** **Iter 4:** all product flows clean; found **022 — fixture arm
  playlists ran on independent clocks**, so two arms displayed different sentences
  (misleading for comparison QA; impossible in production where mic audio is shared). Fixed
  with a shared utterance timeline anchored at first arm start; late arms join at the next
  shared utterance (461 tests).
- **Iter 5: clean pass #1.** Shared timeline verified live mid-stream. **Iter 6: clean pass
  #2 — converged.** fail-mt journey re-verified end-to-end (exact stage-attributed copy,
  session recovery). Zero console errors across all six iterations.
- QA totals: 7 findings filed, 7 fixed and re-verified in-browser. Standing escalations:
  real-mic journeys + real-provider end-to-end audio (adapter-level smokes passed; browser
  pane cannot grant capture) — operator's morning checklist.

## Closing summary

**Delivered tonight** (all committed on main, never pushed):
- Both arms fully built: Arm A (Realtime, browser WebRTC + ephemeral tokens, GA events,
  sidecar transcription, opaque-failure copy) and Arm B (OpenAI cascade with streaming
  MT→TTS bridge, stage-attributed failures), behind one `InterpreterTransport` contract with
  a fan-out ArmRouter — the UI cannot tell arms apart.
- Fixture providers for every stage + fixture transports + browser fixture mode (`?fixture=1`).
- ElevenLabs Flash v2.5 TTS adapter with TRUE streaming text input — validates the PRD's
  central `AsyncIterable<string>` interface decision against a real API (first audio 318 ms
  through the production adapter). Registered as a second real TTS provider; NOT an arm.
- Swappability proven: OpenAI TTS + ElevenLabs TTS + FixtureTts pass ONE shared contract
  suite unchanged (same for STT/MT implementations).
- Full PRD §6 session cockpit + §7 results view (mandatory empty states, realness rule) +
  blind compare with auditable randomized draws — pixel-faithful to the design handoff.
- Session lifecycle FSM incl. four-value mic permission with two-layer remediation; queue-at-
  boundary switching; reconnect model.
- Placeholder corpus (36 synthetic WAVs, marked, never reported), fixture bench harness,
  stability soak (53k utterances / 8.5 min / heap flat — no leak signal).
- Test suite: **461 tests, 34 files**, all six PRD §12 categories incl. instrumentation
  validation and turn-final mapping. Typecheck + build + prod boot green.
- README, AGENTS.md, .env.example, this log.

**Money:** total real-API spend ≈ **$0.01** of the $5 cap (preflight spikes ~$0.005 +
adapter smokes ~$0.003 + a little ElevenLabs quota). Everything else ran on fixtures.

**Deviations from PRD (all logged above in place):** GA realtime event names; 24 kHz
end-to-end (16 kHz rejected by OpenAI transcription); tsx-run server instead of tsc-emit;
Cantonese warnings visible while idle (informative, warn-never-block preserved); switch
requested at an utterance boundary applies immediately (PRD only specified the mid-utterance
case).

**Needs you (operator):**
1. **Corpus recording** — real EN/ES clips (verbatim scripts) + your 12 Cantonese clips;
   then benchmark sweeps, WER, and the results view light up with real data.
2. **Arm C vendor decision** — no Deepgram adapter exists by design; the contract suite makes
   it a one-file addition.
3. **Blind scoring** — flow is built and unscored; needs you + the Spanish-speaking coworker.
4. **Benchmark sweeps + write-up** — Playwright sweep runner still to build on top of
   src/harness (deliberately deferred: sweeps need the real corpus anyway).
5. **ElevenLabs billing check** — key is TTS-scoped (subscription/history endpoints 401);
   verify aggregate-vs-per-chunk in the dashboard or widen the key scope. Until then no
   ElevenLabs cost figure may be reported (PRD §5 trap).
6. **Deploy** — AWS credentials absent; EC2+Caddy per PRD §13 when you're ready.
7. Real-mic + real-provider browser session — 2-minute sanity pass on your machine
   (`npm run dev`, speak into it); everything below that layer is smoke-tested.
