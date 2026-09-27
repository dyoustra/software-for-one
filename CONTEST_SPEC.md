# Contesting a Locked Test — Spec

**Status:** Implemented, 2026-09-27. See §11 for where it differs from the design
**Date:** 2026-09-27
**Depends on:** `PHASE_2_SPEC.md` §3–4 (tests written blind, then locked), `docs/RUNBOOK.md` B11
**Precedes:** `PARALLEL_SLICES_SPEC.md` (built second; it generalizes the loop this changes)

---

## 1. The problem

Locking the tests stops a build agent from changing its target. It does nothing
about the opposite failure: a target that is wrong. B11 met both kinds of wrong
test.

- **AC-009 had no code that could pass it.** The test measured memory with an
  instrument no implementation could satisfy. S-01 failed twice and eight of
  eleven slices were skipped until a human rewrote the test.
- **S-04's tests could only be passed by wrong code.** A fixture's
  `monkeypatch.undo()` also reverted environment the fixture had set up. The
  agent knew: it first tried a `conftest.py`, which the lock rejected. Then it
  changed production code, caching resolved credentials per directory in
  `resolve_run_environment()`, so the flawed tests would pass. Every gate
  passed and nobody was told.

The second failure is the dangerous one. A cap on attempts stops the first. The
second is invisible, because the gate says "pass".

The agent needs a legitimate way to say "this test is wrong", and the answer
has to come from someone who isn't the agent.

## 2. Shape

This adds no pipeline stage and no new human stage. It adds three things:

1. **A contest.** The build agent may write `.sfo/CONTEST.json` and stop,
   instead of working around a test.
2. **An adjudicator.** It is a separate headless run with its own prompt, and
   it rules on the contest. It runs as stage name `adjudicate-<slice>`, the
   same way a slice runs as `build-<slice>`. It is not in `PIPELINE_STAGES`.
3. **A ruling.** It is recorded in `.sfo/CONTESTS.jsonl` and `DECISIONS.jsonl`,
   and reported in `SUMMARY.md`.

```
build-S-04 ──writes CONTEST.json──▶ adjudicate-S-04
                                        │
         ┌──────────────────────────────┼──────────────────────────────┐
      uphold                       amend_test                   criterion_defect
         │                              │                              │
 slice retries with the          tests rewritten, relocked,     park for human; answer
 ruling in its prompt            passed slices re-verified,     patches that criterion,
 (attempt not counted)           slice retries fresh            adjudicator rewrites its
                                                                test, build resumes
```

## 3. The contest

### 3.1 Build prompt

`build.md` gains a section. The substance:

> If you are confident a test for your slice is wrong — it contradicts its
> criterion, it cannot be satisfied by any correct implementation, or it can
> only be satisfied by code that would be wrong in real use — do not work
> around it. Do not change production code to fit a defective test. Write
> `.sfo/CONTEST.json` and stop. You get one contest for this slice. A contest
> that is ruled against you costs you nothing but the time; working around a
> wrong test is a defect in what you deliver.

`buildPromptFor` shows that section only while the slice's contest is unused.
Once it's used, it shows the ruling instead (§5.1).

### 3.2 Schema

`.sfo/CONTEST.json`, written by the build agent:

```json
{
  "sliceId": "S-04",
  "criterionId": "AC-021",
  "testFile": "tests/test_s04_credentials.py",
  "testName": "test_env_restored_after_run",
  "claim": "unsatisfiable | contradicts_criterion | forces_wrong_code",
  "why": "monkeypatch.undo() in the fixture also reverts ANTHROPIC_API_KEY, which the fixture set, so ...",
  "proposedFix": "Set the key with a nested monkeypatch context so undo only reverts the test's own changes."
}
```

It's validated with zod. A malformed or unreadable contest counts as a failed
attempt, with the parse error sent back as the previous failure. It does not
count as a contest.

### 3.3 Detection

After a build run exits, and before the gate runs:

- If `.sfo/CONTEST.json` exists and the slice's contest is unused, skip the
  gate. The agent stopped on purpose, so grading its unfinished tree would
  record a failure that isn't one. Move the file into `CONTESTS.jsonl` as
  `status: "open"` and run the adjudicator.
- If it exists and the contest is already used, delete it and grade the slice
  as usual. The prompt said one contest, and the gate is the answer.
- The attempt doesn't count toward `MAX_SLICE_ATTEMPTS`, but its cost does.

## 4. The adjudicator

### 4.1 Inputs and independence

- **Reads:** `SPEC.md`, `CRITERIA.jsonl`, the contest, and the test tree
  (including shared support such as `tests/support/`).
- **Does not read** the implementation under `src/`. It judges the test against
  the criterion. The build agent's code is exactly the thing that might have
  bent to fit, so it must not be the reference. Enforce this in two ways: the
  prompt says so, and `--disallowedTools 'Read(src/**)'` blocks it (confirm the
  rule syntax against the CLI when this is built).
- **Tools:** the toolchain from `agentToolsFor(archetype, true)`, so it can run
  the contested test to show it is self-inconsistent. It gets no network tools.
- **Model:** the default (Opus). This is the one judgment that sits between a
  test and the build, so it isn't the place to economize.

### 4.2 Ruling

`.sfo/RULING.json`, written by the adjudicator:

```json
{
  "ruling": "uphold | amend_test | criterion_defect",
  "why": "…",
  "changedFiles": ["tests/test_s04_credentials.py"],
  "question": null
}
```

`question` is required when `ruling` is `criterion_defect`, and holds a
`QuestionSchema` object. It must be null otherwise.

### 4.3 What it may change: tests only

The adjudicator may edit files under `tests/` and any `conftest.py`. It may not
touch criteria, the spec or source. Whether it stayed in bounds is checked
mechanically: after it exits, `git status --porcelain` in the project must show
changes only to paths the test lock covers (the `walkTestTree` set plus
`collectionHooks`). If it touched anything else, revert everything it changed
and treat the ruling as `uphold`, with the reason "the adjudicator went outside
the test tree". An out-of-bounds ruling is never trusted.

An `amend_test` ruling that leaves the test-lock hash unchanged has changed
nothing. Treat it as `uphold`.

## 5. Acting on the ruling

### 5.1 `uphold`

The contest is spent. The slice runs again, and the ruling's `why` goes into
the prompt in place of the contest section:

> Your contest of `test_env_restored_after_run` was ruled against: <why>. The
> test stands. Make it pass without changing tests.

### 5.2 `amend_test`

In order:

1. Run the pre-lock suite check (`checkSuiteBeforeLock`: install, lint and
   typecheck). If it fails, revert the adjudicator's changes and treat the
   ruling as `uphold`, with the check's output as the reason. A rewritten test
   that doesn't lint is no better than the one it replaced.
2. `lockTests`. Commit as `adjudicate(S-04): <one-line why>`, staging only the
   changed test paths, not `-A`.
3. **Re-verify every passed slice.** The amended file might be shared support.
   Run the gate for each slice in `slicesPassed`. Any that now fail are removed
   from `slicesPassed`, their `sliceAttempts` cleared, and they are built again
   in the normal order. The results go into `VERIFY.jsonl` as usual, tagged
   `trigger: "relock"`. This costs seconds per slice and no model calls.
4. The contested slice's `sliceAttempts` is reset to 0. The slice was graded
   against a broken test, so its earlier failures don't count against it.
5. Append a decision with `decided_by: "adjudicator"`.

### 5.3 `criterion_defect`

The test measures the criterion correctly, but the criterion is what's wrong:
it's ambiguous, impossible, or contradicts another criterion. This is a
clarify-class question, and clarify is the only place a human is asked
anything.

1. Append `ruling.question` to `QUESTIONS.json` with id `CQ-<slice>-1`,
   section `blocking`, and `context` holding the contest and the ruling.
2. Park with the new variant `{ park: "criterion"; sliceId; criterionId; questionId }`.
   `currentStage` stays `build`, like the other non-human parks.
   `sfo status` shows `criterion AC-021 needs you — \`sfo answer <id>\``.
3. `sfo answer` already asks every open question, so it needs no change.
4. On resume, `advance` sees the park's question has been answered, and runs
   the adjudicator a second time in *patch mode*. It gets the original
   criterion, the question and the human's answer. It rewrites that one
   criterion in `CRITERIA.jsonl` and its test, and then §5.2 runs. The
   decision is `decided_by: "human"`, because the human chose what the
   criterion now says and the adjudicator only wrote it down.
5. No other criterion or slice is regenerated. Slices that passed stay passed,
   subject to §5.2 step 3.

Patch mode is the only time the adjudicator may write to `CRITERIA.jsonl`, and
it may change only the named criterion. The bounds check in §4.3 allows exactly
that one line to change.

## 6. Records

`.sfo/CONTESTS.jsonl`, one record per contest, updated once the ruling is in:

```json
{"sliceId":"S-04","criterionId":"AC-021","testFile":"…","testName":"…","claim":"forces_wrong_code",
 "why":"…","proposedFix":"…","status":"ruled","ruling":"amend_test","rulingWhy":"…",
 "changedFiles":["tests/test_s04_credentials.py"],"decided_by":"adjudicator",
 "openedAt":"…","ruledAt":"…"}
```

- `DecisionSchema.decided_by` adds `"adjudicator"`. It stands apart from
  `"agent"`, which today means the model that did the work also made the
  decision, and here that isn't true.
- `deliver.md` reads `CONTESTS.jsonl` and puts every amended test and patched
  criterion under a "Tests changed after lock" heading in `SUMMARY.md`. A test
  that changed after the lock is exactly what a human reviewer needs to see.
- `sfo slices <id>` shows a contest marker next to any slice that has one.

## 7. Parallel interaction (for `PARALLEL_SLICES_SPEC.md`)

If a relock happens while other slices are in flight, it takes effect
immediately. Those slices are verified again against the new lock when they
merge. That rule already exists in the parallel spec, so a relock adds nothing
to it.

## 8. Costs

With no contest, the cost is zero. A contest costs one adjudicator run, likely
$1–3 on Opus with the test tree in context, plus one slice rerun. In B11, that
is roughly what AC-009 cost in wasted attempts before a human stepped in. It
would also have caught S-04, which no amount of spend caught.

## 9. Out of scope

- **Detecting code bent to fit a test the agent didn't contest.** That would
  need a reviewer that reads the diff against the criterion. The review stage
  partly does this today. It is not a gate.
- **Contests outside the build.** For example, `test-repair` finding a
  criterion untestable. It should use the same records, but has no trigger yet.
- **Acting on `REVIEW.md` findings.** This is a separate open item.

## 10. Tests to write

- A contest file skips the gate, opens a record and doesn't count the attempt.
- A second contest on the same slice is deleted and the slice is graded as
  usual.
- A malformed contest counts as a failed attempt carrying the parse error.
- `uphold` puts the ruling into the next build prompt and removes the contest
  section.
- `amend_test` that touches `src/` is reverted and treated as `uphold`.
- `amend_test` with an unchanged lock hash is treated as `uphold`.
- `amend_test` that fails the pre-lock check is reverted and treated as
  `uphold`.
- `amend_test` relocks, re-verifies passed slices, reopens any that now fail,
  and resets the contested slice's attempts.
- `criterion_defect` appends the question and parks. `status` shows the note.
  After an answer, patch mode changes exactly one criterion.
- In patch mode, a change to a second criterion is rejected by the bounds
  check.
- `decided_by: "adjudicator"` parses. `SUMMARY` input includes the contests.

## 11. As built

- **Independence is structural, not a tool rule.** Before the adjudicator runs,
  the slice's uncommitted work is stashed (everything except `.sfo/`, which
  holds live pipeline state). The adjudicator then sees only committed code
  from slices that already passed, so it can't take the contested code as its
  reference, whatever it reads. That replaces the planned
  `--disallowedTools 'Read(src/**)'`, whose rule syntax was never confirmed.
  An amendment is committed while the work is still stashed, so only the test
  and the lock go into that commit. After that the work is restored. If it no
  longer applies, it's discarded with a warning, and the slice's next attempt
  starts from the committed tree.
- **The adjudicator gets the build's tools**, network included. §4.1 said no
  network. It shares the build's allow-list instead of having one of its own.
- **Bounds check:** `git status` outside `.sfo/`, with any path not under
  `tests/` and not a `conftest.py` counting as out of bounds. Changes the
  adjudicator makes to `.sfo/` aren't policed, apart from the criteria file in
  patch mode. That file is compared line by line: same ids in the same order,
  and only the named criterion's `text` may differ.
- **Patch mode accepts a reworded criterion that needs no test change.** If
  the lock is unchanged but the criterion was reworded, that's a complete
  amendment. Only the criteria file is committed, and the slice's attempts are
  reset.
- **A usage limit during adjudication spends nothing.** No record is written,
  CONTEST.json is consumed, and the slice can contest again on its next
  attempt.
- **A question is identified as `CQ-<slice>`,** and it counts as answered only
  when the answer's recorded question text matches (the `openQuestions` rule).
  A stale answer under the same id is not applied.
- **`sfo slices` shows no contest marker.** That command shows the plan, not
  build progress. Contests appear in `sfo status` (while parked), in
  `DECISIONS.jsonl`, and in `SUMMARY.md`'s "Tests changed after the lock".
- **Mutation-checked guards:** the stash, the bounds check, one contest per
  slice (without it the build loops forever), re-verifying passed slices after
  a relock, waiting for a matching answer, the pre-lock check on an amendment,
  and the attempt reset.

