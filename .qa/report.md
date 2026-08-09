# QA report — PAUSED mid-pass (operator recording corpus takes)

```yaml
sha: ca40359
branch: main
tree: dirty (temp_report.md untracked — an audit artifact, not code)
launched: reused the operator's running `npm run dev` (5173 client / 8787 API)
status: PAUSED after the three priority claims + Live must-have #7. Full walk not completed.
```

## The three audit claims — settled

**A. "Results renders aggregates over zero qualifying runs" — REFUTED.**
Experiment 1 and Experiment 2 both render their empty states verbatim: *"no sweep runs recorded for
Arm A vs Arm B"* / *"...Arm B vs Arm C"*. No `p50 1.15 s`, no `5 of 5 reps · 65 of 65 samples`.
localStorage was inspected directly and **exactly mirrors the server** — same 3 run ids, same
origins/statuses, 8 LiveSessions, 1 Recording, and **0 utterance records** (not the alleged 41). The
cards show empty states *while* localStorage is populated, so they cannot be sourced from it.
The Live-conversation card DOES show figures (8 sessions, 31 utterances, p50 0.40 s realtime /
1.49 s cascade) — that is a separate, honest source (LiveSessions), and ticket 051 made those
percentiles derive from utterance marks, which is why sessions storing `p50: null` now show real
numbers. Correct, not a defect.

**B. "A stored run has negative latency, marked complete" — CONFIRMED, and it reaches TWO surfaces.**
- Results › By Recording: Arm B row renders **`-1.44 s`** in the P50 column.
- Replay › run listing: run `7acb0cc9` renders **`total -13973 ms`**.
Both are correctly labelled `excluded · manual`, so the aggregation gate holds — but a physically
impossible latency is displayed as a figure.

**C. "The corpus is not loaded" — CONFIRMED.** The Recordings library lists exactly **1** Recording
against **36** clips committed under `corpus/`.

## Also found (not in the audit)

**`$0.000` still renders on two surfaces**, violating ticket 052's core rule that an unmeasured cost
reads `not measured`, never `$0.00`:
- Results › By Recording — `$0.000` in the COST column on both rows
- Replay › run listing — `$0.000/min` on both complete runs
Live's footer is CORRECT (`session not measured · 0 of 0 metered`), so this is the same
"module is solid, its consumers are untested" pattern 052's own review named.

**Replay run cards render every stage as `—`** on 2 of 3 runs (`endpointing — stt — mt — tts —
queue —`). Those runs predate tickets 051/052; nothing has been re-run since.

**Must-have #8 (comparison write-up) has no artifact.**

## Verified CORRECT

- **Must-have #7, Live per-stage display (ticket 051)** — Arm A: ONE row `model` + `opaque`, span
  `detected end of speech → audio starts`, 0.48 s. Cascade: FOUR rows — `transcribe` 0.04 s /
  `translate` 0.30 s / `synthesize` 0.20 s / `deliver` 0.01 s, each naming its span. Arithmetic
  checks: 0.04 + 0.30 + 0.20 = 0.54 = the total, with `deliver` correctly outside it.
- **Bars decompose the HEADLINE** — 8% / 55% / 37% = 100% across the three headline stages;
  `deliver` has the track and **no fill**. Exactly as specified.
- **Total label byte-identical across arms** — `total detected end of speech → audio starts`.
- **No `endpointing` anywhere in Live** (body-text sweep: false). Replay correctly KEEPS it.
- **Must-have #4** — Realtime→Cascade switched mid-session and the card rebuilt.
- **Must-have #5** — `English → Spanish` selector with swap.
- **Must-have #6** — source (English) and target (Spanish) transcripts both rendered live.
- **Ticket 047** — no play/pause control in Live; `autoplay on`.
- **Ticket 052 on Live** — footer reads `session not measured · 0 of 0 metered`, plus the anchor
  note `from detected end of speech`.
- **Ticket 024** — Run / Batch sweep disabled with an explanatory title until a Recording is picked.
- **Ticket 018** — a `?fixture=1` session produced 4→13 utterances and the footer p50/p95 stayed `—`;
  the fixture session wrote **nothing** to the server (`live-sessions.jsonl` unchanged at 8 rows).

## Not walked (pass paused)
Help tab; mic-permission denial copy; blind-compare flow; Replay record flow; batch sweep;
error/empty states beyond those above; the rubric's performance benchmarks and 5-minute stability
(both need a real microphone session — escalation).

---

## Findings added while paused (read-only verification of a third-party audit)

### F1 — BLOCKER: the coverage card cites TWO COMMIT HASHES THAT DO NOT EXIST
`src/client/views/ResultsView.tsx:653-654` hardcodes:
```
'Spanish → English on cascade · commit a4f21c · +11 lines · one language constant'
'English → Cantonese on cascade · commit 9d0e77 · +14 lines · one voice id per direction'
```
`git cat-file -t a4f21c` and `git cat-file -t 9d0e77` both fail — **Not a valid object name.**
These render on the Results screen (observed in this pass) as evidence of onboarding cost.
PRD §11 stakes that card on *"onboarding cost is proven by commit, not claimed."* The app is
presenting fabricated proof. This is more serious than any number on the screen, because a wrong
figure is an error while a wrong citation is a claim of evidence that was never gathered.

### F2 — the negative latency is PER-UTTERANCE and PROGRESSIVE, not a single bad total
A third-party audit attributed run `7acb0cc9`'s `−13,973 ms` to the run having processed only one of
four utterances. **That framing is wrong** — all four utterances processed, each with source and
target transcripts. The actual per-utterance arithmetic (`audio_queued − speech_end`):

| utterance | source | delta |
|---|---|---|
| 0 | "Ok." | **+3424 ms** |
| 1 | "at all." | **+1231 ms** |
| 2 | "Monday the 4th." | **−1435 ms** |
| 3 | "I think it was Tuesday, no, Wednesday…" | **−2364 ms** |

Two of four are inverted, and it is the LATER two — `speech_end` drifts later than `audio_queued`
as the run proceeds. Nearest-rank p50 over those four is −1435 ms, which is exactly the `-1.44 s`
rendered in Results › By Recording. So the UI is faithfully reporting a real measurement defect;
the display is not the bug.
A clock guard at write time is the right backstop but it is NOT the fix — it would relabel this run
`failed` and hide a systematic drift in how `speech_end` is assigned per utterance.

### F3 — run-level `transcripts` holds ONE pair for a 4-utterance run
`7acb0cc9`'s run-level `transcripts` is a single `{source, target}` object carrying only utterance
3's text, while `utterances` correctly holds all 4 with their own transcripts. A run-level summary
field silently representing the last utterance is a reporting trap, though the per-utterance records
— which PRD §8 makes the measured atom — are intact.

### F4 — `languagePair` and `direction` are `undefined` on EVERY stored Run
All 3 runs: `languagePair: None`, `direction: None`. The controlled-variable register pins
*"Language pair + direction — fixed per sweep."* EN→YUE and YUE→EN are separate claims (PRD §7); a
run that does not record its own direction cannot be grouped correctly by the by-category view.
