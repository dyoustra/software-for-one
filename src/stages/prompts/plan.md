Read `.sfo/SPEC.md` and `.sfo/CRITERIA.jsonl`.

Group the criteria into build slices and write `.sfo/SLICES.jsonl`, one JSON
object per line:

    {"id":"S-01","name":"Enumeration and file identification","criterionIds":["AC-001","AC-002"],"prerequisites":[]}

**Start from the `group` field already on each criterion.** The spec stage
clustered them while holding the full design in context; your job is to refine
that grouping, not replace it.

Refine it by these rules:

- **Merge groups smaller than about four criteria** into the most closely
  related neighbour. Each slice costs a fixed amount to run regardless of size,
  so a two-criterion slice is mostly overhead.
- **Split groups larger than about twelve** along a natural seam. A slice should
  be a tractable unit of work, not a wall of failing tests.
- Aim for five to ten criteria per slice.
- Every criterion must appear in exactly one slice. None may be dropped.

Set `prerequisites` to the slices that must be working first — naming needs
enumeration, collision handling needs naming. Keep these minimal and real: a
prerequisite that is not genuinely required only serialises work and widens the
blast radius when something fails, because a failed slice skips everything
downstream of it. Leave `prerequisites` empty for anything independent.

Order the slices so that a person building this by hand would work in that
order.

Also write `.sfo/PLAN.md`: a short prose summary of the build order and why the
slices are cut where they are. Nothing stops for a human to approve it — it is
read after the fact, by someone working out why the build went the way it did,
and by the deliver stage. Write it to be understood cold, months later.

Finally, append one line to `.sfo/ESTIMATE.jsonl` estimating what everything
after this stage will cost — `test-write`, `test-repair`, every build slice,
`review` and `deliver`:

    {"phase":"build","lowUsd":12.0,"highUsd":30.0,"basis":"test-write for 60 criteria, test-repair, 8 slices, review, deliver; cli-python","at":"<ISO 8601>"}

`phase` is exactly `build`. `lowUsd` must not exceed `highUsd`. `at` must be a
real ISO 8601 timestamp. `basis` is one line saying how you arrived at the
figure — it is what a human checks your reasoning against.

Calibrate against what this pipeline has actually cost, measured:

- A multi-turn stage that reads a lot and writes a lot: **$1–$2**. `spec` cost
  $0.99, `research` $1.81, `clarify` $0.79.
- The floor for any invocation, however small, is about **$0.29** — that is the
  cost of loading context before the work starts.
- Long stages are dominated by cache reads, not output tokens, so cost tracks
  how much the agent must *read* far more than how much it writes.

- **`test-write` is the most expensive stage measured so far.** For 80 criteria
  it cost **$11.73**: 134 turns, 32 minutes, a 4,400-line suite. It writes the
  whole contract in one invocation, re-reading a growing suite every turn, so
  scale it with criterion count — about $0.15 per criterion — not with slices.

What follows this stage is `test-write`, then `test-repair`, then one build
invocation per slice plus up to one retry for a slice that fails its gate, then
`smoke` — real calls to each seam in `.sfo/SERVICES.jsonl` costing at most the
sum of their `smoke.maxCostUsd` and no more than $2, plus up to two repair
invocations if a seam fails — then `review` and `deliver`. Estimate the range that follows from your criterion and
slice counts, and say in `basis` what each part contributes and whether the high
end assumes retries.

**Be honest rather than reassuring.** A low estimate does not make the build
cheaper; it only removes the person's chance to stop before paying. If the
number is uncomfortable, that is the number.

Write only `.sfo/SLICES.jsonl`, `.sfo/PLAN.md`, and `.sfo/ESTIMATE.jsonl`.
