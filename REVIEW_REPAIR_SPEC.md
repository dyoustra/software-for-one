# Review → Repair — Spec

**Status:** Implemented, 2026-09-27
**Date:** 2026-09-27
**Depends on:** `CONTEST_SPEC.md`, `SMOKE_SPEC.md`
**Original design:** `SOFTWARE_FOR_ONE_SPEC.md` §9, which says review returns
`pass / repair / escalate` and a repair loops back to build, bounded at 2.

---

## 1. Why

Review today writes `REVIEW.md` and nothing acts on it. B11's review found a
real gap: `--resolution` was never tied to the bytes sent. It was reported, and
it shipped. The spec calls this second gate *adversarial review*, the check
that catches **hollow** where the gate catches **broken**. A gate that only
reports isn't a gate.

## 2. Shape

```
review (round 1) ──▶ findings ──▶ high + code + reproduced? ──▶ review-repair (≤2 attempts)
                                                                        │
                                             repair kept? ──▶ smoke again (no repair)
                                                                        │
                                                        review (round 2, report only) ──▶ deliver
```

That's at most two reviews and one repair round. It can't churn.

## 3. Findings: `.sfo/FINDINGS.jsonl`

Review writes `REVIEW.md` for the human and `FINDINGS.jsonl` for the pipeline:

```json
{"id":"R-001","round":1,"severity":"high","kind":"code","criterionId":"AC-031","decisionId":null,
 "summary":"--resolution is never applied to the image bytes sent",
 "evidence":"send() always encodes the original bytes; nothing reads settings.resolution",
 "test":"tests/review/test_r001_resolution.py","status":"open"}
```

- **`severity`:** `high`, `medium` or `low`. Only `high` can trigger repair.
- **`kind`:**
  - `code`: the behaviour is wrong or hollow against a criterion. This is the
    only repairable kind.
  - `coverage`: a test is weaker than its criterion, or missing.
  - `spec`: the spec or a criterion looks wrong or contradictory. Reported,
    never repaired, because fixing a spec needs the person.
  - `seam`: an unlisted seam, or a fake that's looser than its service.
  - `safety`: an irreversible-looking smoke test. It leads the report.
- **`decisionId`:** set when the finding challenges a recorded decision. **A
  finding against a decision with `decided_by: "human"` is dropped
  mechanically:** the person's choice is the spec. Agent decisions may be
  challenged by naming them.
- **`status`** is set by the pipeline, not the reviewer: `open`, `repaired`,
  `unrepaired`, `not_reproduced`, `report_only`, or `dropped`.

## 4. Every repairable finding comes with a failing test

For each `high` + `code` finding, round 1 also writes a test that reproduces
it, in `tests/review/`, named for the finding (`test_r001_*.py` or
`r001-*.test.ts`). The reviewer never saw the build transcript, and it writes
the test the repair must pass. So "fixed" is decided by the gate, not by one
model's opinion of another's work. The test then stays in the suite as a
regression guard.

The pipeline checks each test before it counts:

1. **Bounds.** The reviewer may write only `REVIEW.md`, `FINDINGS.jsonl` and
   files under `tests/review/`. Anything else is reverted.
2. **Pre-lock check.** A test that fails lint or typecheck is discarded, and
   its finding becomes `unrepaired` with the reason. A test that doesn't lint
   would fail every gate after it's locked.
3. **Reproduction.** The test is run alone against the current code and **must
   fail**. If it passes, the finding isn't reproduced: the test is discarded and
   the status is `not_reproduced`. It's reported but never repaired.
4. **Lock and commit.** The surviving tests are locked with the rest of the
   suite, and committed on their own.

## 5. Repair

- **Stage `review-repair`:** a build agent is given the findings, their
  evidence and their failing tests. It may change code, never tests.
- **Gate:** every *passed* slice's tests **plus** every locked review test,
  all together. A repair that fixes a finding but breaks a slice is discarded.
- **Two attempts.** A failed attempt is discarded, and its gate output goes
  to the next attempt.
- **One contest, under the id `REVIEW`.** A review test can be wrong too. It
  follows `CONTEST_SPEC.md`, with criterion defects recorded, not parked.
- After repair, each finding whose test passes is `repaired`, and the rest are
  `unrepaired`.

## 6. After a kept repair

- **Smoke runs again,** within the same cap and with no repair pass, so the
  delivered code is what was checked against the real services.
- **Review round 2 is report only.** It's the same prompt, told that a repair
  round has run and not to write tests. Its findings are recorded with
  `round: 2` and `status: report_only`.

If no repair was kept (nothing repairable, or every attempt failed), there's no
second smoke run and no round 2.

## 7. Nothing parks

`escalate` in the original design becomes *reported first*. Unrepaired high
findings lead `SUMMARY.md`, next to failed seams. You decided that a human is
asked only at clarify, and this keeps it that way.

## 8. Reporting

- `deliver` reads `FINDINGS.jsonl`. A `high` finding that isn't `repaired`
  leads the summary. `repaired` findings are listed with their tests.
  `not_reproduced` findings are listed as the reviewer's claims that the code
  disproved.
- `sfo status` says `done, N review findings unrepaired` when that applies.

## 9. Costs

Round 1 costs more than today's review, because it writes tests: roughly
$2–4 on Opus. A repair attempt costs about what a slice does ($2–4). Round 2 is
about $1–2. With nothing repairable, the cost is today's review plus parsing.

## 10. Tests to write

- A finding against a human decision is dropped. One against an agent decision
  is kept.
- `spec` and `coverage` findings, and `medium`/`low` ones, are `report_only`.
- A reviewer's write outside `tests/review/` is reverted.
- A review test failing the pre-lock check makes its finding `unrepaired`.
- A review test that passes against current code makes its finding
  `not_reproduced`, and the test is discarded.
- Surviving review tests are locked and committed without the repair's work.
- The repair gate includes passed slices and review tests. A failing attempt
  is discarded, and its output is fed to the next.
- Kept repair: statuses are set per test, smoke re-runs with no repair pass,
  and round 2 runs report-only.
- No kept repair: no second smoke run, no round 2.
- A `REVIEW` contest follows the contest rules.

## 11. As built

- **A repair is kept on progress, not perfection.** Its gate is every passed
  slice plus the review tests *already* repaired, and it must make at least
  one more finding's test pass. Fixing two findings of three is kept. A
  repair that breaks nothing but fixes nothing is discarded, and the next
  attempt is told so.
- **A `high` + `code` finding with no test is `unrepaired`, not demoted.**
  "Repairable" means serious and about behaviour. Whether the reviewer proved
  it is a separate question, and the answer is recorded as the reason.
- **Drift guard.** Locking review tests re-hashes the whole suite, so any
  change to the suite outside `tests/review/` since the last lock blocks the
  lock, and the findings are marked `unrepaired`. That way relocking can't
  quietly accept an edit made earlier.
- **Round 2 hitting a plan limit is skipped, not parked.** The first round's
  findings stand, with a warning.
- **Mutation-checked:** binding human decisions, reproduction, bounds, the
  progress rule, gating on already-repaired tests, round 2 only after a kept
  repair, round 2 report-only, and the pre-lock check.

