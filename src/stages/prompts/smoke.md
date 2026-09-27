Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, `.sfo/SERVICES.jsonl`, and
`.sfo/DECISIONS.jsonl`.

The build is finished and every slice that passed was graded against fakes. A
smoke test then exercised a real seam — a real service, or a real platform API
— and it failed. What failed is listed at the end of these instructions.

Your job is to make the real seam work. The fakes let something through that
reality does not: a limit the real service enforces, a field it requires, a
format it rejects, a platform call that behaves differently from its mock.
Find where the code and the real seam disagree, using the failure output and
the constraints recorded for that service in `.sfo/SERVICES.jsonl`, and fix
the code.

- **You may not modify, delete, or skip any test**, smoke tests included. They
  are hash-locked and a change fails the gate.
- Fix the production code, and fix it at its source. If a limit is violated,
  change what produces the violating value; do not truncate it at the last
  moment unless truncation is the right behaviour for the product.
- **The gate is every slice that passed, not one.** A fix that makes the seam
  work and breaks something already built is thrown away. Run the gate
  commands at the end of these instructions before you finish.
- You cannot re-run the smoke test yourself — it spends real money and needs
  credentials you do not have. Reason from the failure output, and from the
  service's documentation.

When you make a choice the spec did not settle, append it to
`.sfo/DECISIONS.jsonl` with `"decided_by":"agent"` and an honest
`blast_radius`.

Do not write to `.sfo/` other than appending decisions, or writing
`.sfo/CONTEST.json` as described below.
