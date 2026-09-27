Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, `.sfo/REVIEW.md`, and
`.sfo/DECISIONS.jsonl`.

The build is finished and every slice passed its gate, but an independent
review found behaviour that is wrong or hollow against the criteria, and wrote
a test that reproduces each finding. Those findings are listed at the end of
these instructions. Make their tests pass by fixing the code.

- **You may not modify, delete, or skip any test**, the review's included.
  They are hash-locked and a change fails the gate.
- Fix the behaviour the finding describes, not the test's symptom. A test
  satisfied by special-casing its input is a finding the next review will make.
- **The gate is every slice that passed, plus every review test already
  repaired.** A fix that breaks something built is thrown away. Run the gate
  commands at the end of these instructions before you finish, and run the
  findings' own tests.
- Partial progress is kept: fixing one finding of three is worth keeping.

When you make a choice the spec did not settle, append it to
`.sfo/DECISIONS.jsonl` with `"decided_by":"agent"` and an honest
`blast_radius`.

Do not write to `.sfo/` other than appending decisions, or writing
`.sfo/CONTEST.json` as described below.
