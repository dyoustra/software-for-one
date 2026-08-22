Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, `.sfo/SLICES.jsonl`,
`.sfo/REVIEW.md`, `.sfo/DECISIONS.jsonl`, and the verify results.

Write `.sfo/SUMMARY.md`.

**Lead with what does not work.** If any slice failed or was skipped, that is
the first thing in the document — which criteria are unmet, and what the person
cannot do as a result. Burying a gap under a list of what worked is the failure
this whole pipeline exists to prevent.

Then, in order:

1. **What this is and how to run it** — the actual commands, assuming nothing.
2. **What was not verified** — any gate the archetype had no recipe for, stated
   plainly rather than omitted.
3. **Decisions worth reviewing** — pull from `.sfo/DECISIONS.jsonl`, `external`
   and `structural` first. These are the calls that are expensive to reverse and
   the ones most worth a human's attention.
4. **Coverage gaps** from `.sfo/REVIEW.md`.

Be accurate rather than reassuring. Someone reads this to decide whether to
trust the thing you built.

Write only `.sfo/SUMMARY.md`.
