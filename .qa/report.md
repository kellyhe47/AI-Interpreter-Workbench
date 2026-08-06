```yaml
sha: 06276b4
branch: main
tree: clean
launched: preview_start "workbench" (npm run dev) → http://localhost:5173
         + API server started separately with PORT=8787 (see F4 — it does not come up correctly on its own)
```

# Manual QA — AI Interpreter Workbench v2 (Replay flow)

**Spec:** `PRD.md` (§6, §7, §8, §10, §12).
**Designs:** `design_handoff_interpreter_workbench/README.md` + `interpreter-workbench-v2.dc.html`. PRD wins on conflict.
*(The v1 QA report is archived at `.qa/report-v1.md`.)*

**Note on screenshots.** The browser tool returns images inline rather than writing files, so `.qa/screens/`
holds captured **DOM-state evidence** for the load-bearing findings rather than PNGs. Every figure quoted
below was read out of the running app, not inferred.

## Flows walked

| Flow | Journey | Result |
|---|---|---|
| A | Cold landing → all four tabs | pass |
| B | Live config, derived arm tag A→B→C→ad-hoc, language + Cantonese | pass |
| C | Full Live session (fixture), tab-switch mid-session, stop | pass, but exposed **F1** |
| D | Live stage failure via `?fixture=fail-mt` | **halted — F5**, fault never injected |
| E | Mic denied | pass |
| F | Replay config panel without data | pass, but exposed **F3, F4, F7** |
| G | Replay with seeded data → runs list → blind compare | pass, but exposed **F6** |
| H | Results, both tabs, empty and populated | **F1, F2, F8** |

Every UI requirement in §6/§7/§8/§10/§12 was touched by at least one flow.

## What is solid

These were checked hardest and hold in the running product:

- **The derived arm tag never lies.** Live: Realtime+`gpt-realtime` → `this is Arm A`; cascade default triple
  → `Arm B`; swap **only** TTS to `eleven_flash_v2_5` → `Arm C` (PRD Exp 2's single-stage swap falling out of
  the UI); `eleven_multilingual_v2` → `ad-hoc`; MT → `claude-haiku-4-5` → `ad-hoc`; a full cycle returns to B.
  The Replay panel behaves identically. The pill is a `<span>`, and **no interactive control anywhere mentions
  "arm"**.
- **Derived beats declared.** A Run *stored* with `armTag: "B"` but an off-arm triple renders **`ad-hoc`** on
  its card, and reveals as `ad-hoc` after blind submit. The stored tag is never trusted.
- **Results empty state.** With an empty ledger the panel contains **zero digits** on both tabs, "Run sweep"
  is disabled with the title *"Sweeps require the real corpus to be loaded"*, and the mock's
  "show recorded runs (mock)" switch does not exist.
- **Blind compare is genuinely blind.** With two runs picked: Sample A/B, adequacy+fluency each, **zero**
  `[data-blind-identity]` nodes, and no model id, arm label or transcript in the visible text. Submit stays
  disabled until all four scores are set. After submit the hint flips to *"identity revealed — appended to the
  ledger"* and the persisted record carries the two run ids, **the drawn order**, both dimensions for both
  samples, and the evaluator language.
- **Corpus Recordings expose no delete control at all** — the corpus row has only an edit affordance, the mic
  row has edit + delete. Disallowed, not warned about.
- **Nothing autoplays in Replay** — rendering four run cards created no media element and triggered no
  playback. The failed run card has no play control and no stage figures.
- **Mic denial** (graded, PRD §7 requirements 1–5): status flips to `mic blocked` / `permission-denied`, a
  blocking card names **both** the browser site permission and the OS privacy setting, states *"Browsers do
  not re-prompt after a denial — reset the site permission first, then retry"*, and Replay/Results/Help stay
  usable.
- **Live indicator persists across tabs.** Started a session, navigated to Replay — the dot stayed. Returning
  to Live showed the same session still running at `1:18 / 5:00`, mic still granted.
- **Cantonese warns, never blocks**, and correctly fires on **target** only: `English → Cantonese` shows the
  banner; swapping to `Cantonese → English` removes it while the pair-level pill still reads "cascade only".
  Pill and warning legitimately disagree, exactly as §7 requires.
- **Observability asymmetry is legible**: Realtime renders 3 intervals with `model` labelled **opaque** plus
  the sidecar note; Cascade renders **5 intervals, all visible**.

## Findings

### F1 — Results reports fixture-sourced figures as measurements · **HIGH**

*Flow C→H.* **Repro:** open `/?fixture=1` → Live → Start microphone → let ~20 utterances run → Stop session →
Results.

**Expected** (PRD §8): *"No number reported in the write-up may come from a fixture run. Fixture latency is a
configured constant."* Plus §17 15g: mandatory empty states exist so *"polished placeholders can never be
mistaken for measured evidence."*

**Observed:** the conversation-length card leaves its empty state and renders **p50 0.98 s, p95 0.98 s,
20 utterances completed, 0 disconnects**, under a mono provenance line reading *"LiveSessions only · 1
sessions · 20 utterances completed"* — with **no "illustrative" badge** and nothing indicating the source was
a fixture. Panel digit count goes 0 → 29.

The Run path enforces the realness rule correctly (Exp 1 and Exp 2 both say "no sweep runs recorded"). The
**LiveSession path has no equivalent gate**. `?fixture=1` is the documented QA/demo path, so this is easy to
hit, and 0.98 s appearing as both p50 and p95 is the signature of a constant-delay fixture.

Evidence: `.qa/screens/F1-results-fixture-livesession.txt`

### F2 — Results never sees server-persisted Runs · **HIGH**

*Flow G→H.* **Repro:** POST two Recordings and four Runs to the real API → Replay → select the corpus
Recording (all four render correctly) → Results.

**Expected** (PRD §8): *"**One ledger under every view.** Every screen reads from a single append-only run
ledger… the ledger is the source of truth, so a metric cannot drift between screens or between a screen and
the write-up."*

**Observed:** Results says **"No runs recorded"** while four Runs exist on the server, two of which pass the
aggregation gate (`run-b-sweep-1` B/sweep/complete, `run-c-sweep-1` C/sweep/complete). The client ledger blob
holds `runs: 0, recordings: 0, liveSessions: 0`. Replay reads the server over REST; Results reads a disjoint
browser-local ledger.

Consequence: after a real batch sweep — which writes Runs server-side — the Results view, the project's
primary deliverable, would still be empty. Combined with F1, Results currently shows **fixture-sourced Live
data and omits real server Runs**, the exact inversion of the intent.

Evidence: `.qa/screens/F2-results-blind-to-server-runs.txt`

### F3 — A dead backend renders as a normal empty state · **HIGH**

*Flow F.* **Repro:** with the API server down, open Replay.

**Expected** (PRD §12): storage and load failures surface clearly; a failure must be distinguishable from
emptiness.

**Observed:** `GET /api/recordings` returns **500 with an empty body** (proxy logs `ECONNREFUSED`), and the
library renders the reassuring *"No Recordings yet — Record a clip or load the corpus. Nothing is listed until
a Recording exists…"*. No error, no retry affordance, no hint the backend is unreachable. An operator would
conclude the app is working and empty.

Evidence: `.qa/screens/F3-dead-backend-reads-as-empty.txt`

### F4 — API server binds the client's port under the repo's own preview config · **MODERATE**

*Flow F.* **Repro:** `preview_start` the `workbench` config from `.claude/launch.json` (which declares port
5173) → the harness sets `PORT=5173` → `npm run dev` runs client and server concurrently →
`src/server/index.ts` reads `Number(process.env.PORT ?? 8787)` and logs **`server listening on :5173`**.

**Observed:** the API never binds 8787, every `/api/*` call is ECONNREFUSED, and the entire Replay/storage
half of the app is dead in the documented dev/QA path. I had to start the API separately with an explicit
`PORT=8787` to continue this pass. A developer running `npm run dev` from a shell with no `PORT` set is
unaffected — which is what makes this easy to miss.

### F5 — `?fixture=fail-mt` injects no fault · **MODERATE**

*Flow D, halted.* **Repro:** open `/?fixture=fail-mt` → select Cascade → Start microphone → observe.

**Expected:** AGENTS.md documents `?fixture=fail-mt` as fault injection, and PRD §12 makes the
architecture-differentiated failure copy a finding: *"mt stage timed out for this utterance — session still
running"* versus Realtime's opaque string.

**Observed:** `location.search === "?fixture=fail-mt"` is active, the session ran to **utterance 17**, and no
stage failure ever surfaced — `/stage timed out/i` and `/opaque failure/i` are absent from the document
throughout; the target card stayed `ready`.

The failure copy itself is implemented (Replay's failed-run card renders *"tts stage timed out — run saved as
failed, excluded from every aggregate"* correctly). What is broken is the documented manual path for
exercising it in Live.

Evidence: `.qa/screens/F5-fail-mt-inert.txt`

### F6 — Blind scores persist only to browser localStorage · **MODERATE**

*Flow G.* **Repro:** Replay → select a Recording with ≥2 completed runs → compare blind → pick two → score all
four → submit → inspect storage.

**Expected** (PRD §7): *"The server owns the store; the client reads and writes it over REST."* §10: scores
append to the ledger, and a coworker scores *"at the same machine or on the deployed instance"*.

**Observed:** the comparison is written to `localStorage["workbench.runLedger.v1"].blindComparisons` and
nowhere else. There is no blind-comparison REST endpoint, so scores never reach `data/`, will not appear in
the `results/` bundle `npm run export-results` produces (which is what the write-up cites), are lost if
browser storage is cleared, and cannot be collected from a second machine or browser.

The record itself is complete and correct — `runIds`, the drawn `order`, both dimensions for both samples,
`evaluatorLanguage`. Only its destination is wrong.

### F7 — Run and Batch sweep are enabled with no Recording selected · **LOW**

*Flow F.* **Repro:** Replay with no Recording selected (panel reads *"select a Recording to run against"*) →
click **Run**.

**Observed:** both buttons are enabled (`disabled: false`, no `title`). Clicking Run is a **silent no-op** —
no run starts, no message, no console error. The app's own Results view models the right pattern: its
"Run sweep" button is disabled with an explanatory title.

### F8 — Provenance stamp asserts a corpus version on an empty Results screen · **LOW**

*Flow A/H.* **Repro:** open Results with an empty ledger.

**Observed:** the top bar renders `run 2026-08-06 · corpus v1` beside a body that says **"No runs recorded"**.
The results panel itself is correctly digit-free, but the stamp sits outside it and reads as though a run
against corpus v1 exists. PRD §8 attaches provenance to results; with zero results there is nothing to
attribute.

## Checked and deliberately **not** filed

- **Recording duration renders `0:00`** — my seeded clips were 0.6 s; real corpus clips are 30–45 s.
  Test-data artifact.
- **Run ids visible in `data-run` attributes during blind compare** — my seed ids (`run-b-sweep-1`) encode the
  arm; production ids are opaque (`run_<ts><seq>_<uuid>`). Visible labels are neutral (`Run 1/2/3`).
- **Empty Recordings library, empty aggregates, `not yet measured` cells** — known-empty by design; the real
  corpus is blocked on the operator.
- **Top bar measures 53px** against the design's 52px — the extra pixel is the border; structurally correct.

## Escalations

- **Audible autoplay** could not be verified — Live states `autoplay on` and emits audio through the playback
  path, but this environment has no audio output to confirm by ear. Needs a human with speakers.
- **Real-provider smoke** for ElevenLabs Scribe and Anthropic MT is out of scope here and costs money; Scribe
  will 401 until the key scope gains `speech_to_text`.
- **A real microphone session** (grantable mic, real speech) needs the operator; this pass ran in fixture mode
  by design.
