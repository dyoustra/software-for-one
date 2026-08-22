Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, `.sfo/SLICES.jsonl`,
`.sfo/REVIEW.md`, `.sfo/DECISIONS.jsonl`, and `.sfo/VERIFY.jsonl`.

`.sfo/VERIFY.jsonl` is what the gate actually did — one JSON object per slice
attempt, appended in the order they ran:

    {"slice":"S-01","attempt":1,"ok":false,"archetype":"cli-python","failedStep":"test","reason":"test failed","tamperedTests":[],"at":"<ISO 8601>"}

- `ok` is the only thing that says a slice passed. Nothing else in the project
  does.
- `attempt` counts from 1. A slice with two records and no `"ok":true` was
  abandoned, and everything downstream of it was never built.
- `failedStep` is the gate step that failed — `install`, `lint`, `typecheck` or
  `test`. It is absent when the gate never reached a step, and then `reason`
  says why: an unlocked or edited suite, an archetype with no recipe, tests that
  could not be located, or a build agent that exited non-zero.
- `tamperedTests` lists test files that no longer matched their hash lock. A
  non-empty list means the build modified the contract it was being graded
  against — say so, plainly, and name the files.
- A slice with **no record at all** was never attempted, because a slice it
  depended on was abandoned first.

Read it as the record of a run, not a scoreboard: a slice that failed on
attempt 1 and passed on attempt 2 passed.

Write `.sfo/SUMMARY.md`.

**Lead with what does not work.** If any slice failed or was skipped, that is
the first thing in the document — which criteria are unmet, and what the person
cannot do as a result. Burying a gap under a list of what worked is the failure
this whole pipeline exists to prevent.

Then, in order:

1. **What this is and how to run it** — the actual commands, assuming nothing.
2. **What was not verified** — from `.sfo/VERIFY.jsonl`: any slice whose gate
   never reached a step, any archetype with no recipe, and anything the recipe
   for this archetype does not cover. State it plainly rather than omitting it.
   "Verified" here means exactly the steps that ran and exited 0.
3. **Decisions worth reviewing** — pull from `.sfo/DECISIONS.jsonl`, `external`
   and `structural` first. These are the calls that are expensive to reverse and
   the ones most worth a human's attention.
4. **Coverage gaps** from `.sfo/REVIEW.md`.

Be accurate rather than reassuring. Someone reads this to decide whether to
trust the thing you built.

Write only `.sfo/SUMMARY.md`.
