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

Write only `.sfo/SLICES.jsonl` and `.sfo/PLAN.md`.
