# Golden evals

Decision fixtures, not UI tests. Each case asserts a **decision or a count** — never model prose —
and every expectation traces to a verified defect or a quoted line of the rubric / PRD.

**Provenance rule.** A case may only encode a fact that was *observed*, not argued. Where the
source audit (`temp_report.md`) was wrong, the case encodes the corrected fact and says so in `why`.
Two cases differ from that audit's draft for exactly this reason — see `02` and `11`.

Run them against pure functions (`derive.ts`, the ledger, `deriveArmTag`, the pacer, `pricing.ts`),
not through the DOM, except where `surface` says otherwise.
