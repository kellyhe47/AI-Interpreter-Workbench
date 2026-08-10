# Corpus scripts — read these verbatim

PRD §9: 9 Recordings holding 36 utterances. 3 Recordings per direction, ~4 utterances each,
≤45 s per recording. Domain is healthcare interpreting, matching the seeded examples.

## How to record (read this first)

1. **Pause about two seconds between utterances.** The segmenter splits on ≥1000 ms of silence
   (`DEFAULT_SEGMENT_OPTIONS.silenceMs`, which IS the pinned VAD control `ENDPOINTING_MS`), so a
   shorter gap merges two utterances into one and a run against that take fails with
   `segmentation: expected 4 utterances, observed 3`. Two seconds is comfortable margin. Do **not**
   pause mid-utterance for longer than that.

   > **Raised from 500 ms to 1000 ms on 2026-08-10**, because at 500 ms a natural speaking pace did
   > not reliably separate utterances. **Takes recorded under the old instruction are unusable** —
   > their ~1 s pauses are no longer gaps at all. Re-record; do not mix old and new takes in one
   > corpus version.
2. **Read verbatim.** WER compares what the pipeline heard against the reference text below. If you
   improvise a word, either re-take or edit the reference to match exactly what you said — otherwise
   the WER figure is measuring your improvisation.
3. **Perform the disfluency and interruption lines.** They are categories precisely because the
   architectures diverge on them. A disfluency read smoothly is not a disfluency.
4. **Categories are deliberately mixed within each recording** and each category appears on two
   *different* recordings. Do not regroup them — §9: grouping would make one recording's aggregate
   systematically worse and invite false inference.
5. Tag each utterance with the category named in **bold** below, and paste its line as the
   reference text. Cantonese takes no reference text.

Roughly 8 seconds per utterance plus the 2 s pauses puts each take near 40 s, inside the 45 s cap.
If a take runs long, drop to 3 utterances rather than shortening the pauses.

---

# Set 1 — English → Spanish (WER computed)

## EN Take 1 — `clinic intake EN take 1`

**short-reply**
> No, none at all.

**numbers-dates**
> Take two hundred fifty milligrams twice a day with food, starting Monday the fourth.

**disfluency**
> It started— sorry, I think it was Tuesday, no, Wednesday morning, right after breakfast.

**proper-nouns**
> Doctor Nguyen referred you to Cedars-Sinai for the MRI on Thursday.

## EN Take 2 — `clinic intake EN take 2`

**long-compound**
> If the swelling gets worse overnight, or if you notice any numbness in your left arm, I want you
> to stop the medication and call the after-hours line before you come back in.

**interruption**
> Wait— before you go on, is she still taking the blood thinner?

**short-reply**
> Since Friday.

**numbers-dates**
> Your appointment is on the twenty-third at ten forty-five, and you should arrive fifteen minutes early.

## EN Take 3 — `clinic intake EN take 3`

**proper-nouns**
> Ms. Okonkwo was seen at Mount Sinai by Doctor Alvarez last November.

**disfluency**
> I take the, um, the white one in the morning and the— the other one, the small blue tablet, at night.

**long-compound**
> Because your blood pressure was high at the last two visits, and because you mentioned the
> headaches, we are going to run the bloodwork today rather than waiting until the follow-up.

**interruption**
> Sorry to cut in— does that include the weekend doses?

---

# Set 2 — Spanish → English (WER computed)

**Give this to your coworker.** Ask them to read it verbatim, with the same one-second pauses. If
any line sounds unnatural to a native speaker, they should change it — but then **update the
reference text here to match exactly what they said**, or the Spanish WER is wrong.

## ES Take 1 — `clinic intake ES take 1`

**short-reply**
> No, ninguno.

**numbers-dates**
> Tome doscientos cincuenta miligramos dos veces al día con comida, a partir del lunes cuatro.

**disfluency**
> Empezó el— perdón, creo que fue el martes, no, el miércoles por la mañana, justo después de desayunar.

**proper-nouns**
> La doctora Nguyen la envió a Cedars-Sinai para la resonancia el jueves.

## ES Take 2 — `clinic intake ES take 2`

**long-compound**
> Si la hinchazón empeora durante la noche, o si nota entumecimiento en el brazo izquierdo, quiero
> que deje el medicamento y llame a la línea de urgencias antes de volver a la clínica.

**interruption**
> Espere— antes de que siga, ¿todavía está tomando el anticoagulante?

**short-reply**
> Desde el viernes.

**numbers-dates**
> Su cita es el veintitrés a las diez y cuarenta y cinco, y debe llegar quince minutos antes.

## ES Take 3 — `clinic intake ES take 3`

**proper-nouns**
> La señora Okonkwo fue atendida en Mount Sinai por el doctor Álvarez en noviembre pasado.

**disfluency**
> Tomo la, eh, la blanca por la mañana y la— la otra, la pastilla azul pequeña, por la noche.

**long-compound**
> Como su presión estaba alta en las últimas dos citas, y como mencionó los dolores de cabeza,
> vamos a hacer los análisis hoy en vez de esperar hasta la consulta de seguimiento.

**interruption**
> Perdón que la interrumpa— ¿eso incluye las dosis del fin de semana?

---

# Set 3 — Cantonese → English (WER NOT computed)

**These are prompt cards, not a script.** Per §9 you speak Cantonese but do not read it, so: read
each card **silently**, then say it in Cantonese in your own words. There is no verbatim reference
and no WER — the reference is the English meaning, which is the card itself.

**Leave the reference-text field empty for every Cantonese utterance.** The app withholds it for
`yue` deliberately; a WER of 0 would read as a perfect score rather than "not applicable".

## YUE Take 1 — `clinic intake YUE take 1`

| # | Category | Prompt (say this meaning in Cantonese) |
|---|---|---|
| 1 | **short-reply** | Tell them: no, none. |
| 2 | **numbers-dates** | Two tablets, twice a day, for ten days, starting the sixth. |
| 3 | **disfluency** | Start to say when the pain began, correct yourself on the day, then land on it. |
| 4 | **proper-nouns** | Doctor Chan sent the referral to Queen Mary Hospital. |

## YUE Take 2 — `clinic intake YUE take 2`

| # | Category | Prompt |
|---|---|---|
| 1 | **long-compound** | If the fever comes back after the medicine finishes, and if she is still not eating, bring her in the same day rather than waiting for the appointment. |
| 2 | **interruption** | Cut in to ask whether that includes the child's dose. |
| 3 | **short-reply** | Since this morning. |
| 4 | **numbers-dates** | The appointment is on the eighteenth at three thirty. |

## YUE Take 3 — `clinic intake YUE take 3`

| # | Category | Prompt |
|---|---|---|
| 1 | **proper-nouns** | Mrs. Leung was treated at Prince of Wales Hospital by Doctor Ho. |
| 2 | **disfluency** | Describe taking two different pills, hesitating and self-correcting on which is which. |
| 3 | **long-compound** | Because the swelling has not gone down and because you mentioned the dizziness, we will do the blood test today instead of next week. |
| 4 | **interruption** | Interrupt to ask if the weekend doses are included. |

---

## Category coverage check

Each category appears exactly twice per direction, on two **different** recordings:

| Category | EN | ES | YUE |
|---|---|---|---|
| short-reply | T1, T2 | T1, T2 | T1, T2 |
| numbers-dates | T1, T2 | T1, T2 | T1, T2 |
| disfluency | T1, T3 | T1, T3 | T1, T3 |
| proper-nouns | T1, T3 | T1, T3 | T1, T3 |
| long-compound | T2, T3 | T2, T3 | T2, T3 |
| interruption | T2, T3 | T2, T3 | T2, T3 |

36 utterances, 12 per direction, 2 per category per direction — PRD §9 exactly.
