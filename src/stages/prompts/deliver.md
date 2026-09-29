Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, `.sfo/SLICES.jsonl`,
`.sfo/REVIEW.md`, `.sfo/DECISIONS.jsonl`, `.sfo/VERIFY.jsonl`,
`.sfo/SERVICES.jsonl`, `.sfo/SMOKE.jsonl` and `.sfo/FINDINGS.jsonl` if they
exist, and `.sfo/CONTESTS.jsonl` if it exists.

`.sfo/FINDINGS.jsonl` is the adversarial review's findings, each with the
`status` the pipeline gave it: `repaired` (its reproduction test now passes),
`unrepaired` (still true after the repair round; `statusWhy` says why),
`not_reproduced` (the reviewer's test passed against the code, so the claim was
wrong), `report_only` (not a repairable kind, or found in round 2), or
`dropped` (it contradicted a decision the person made).

`.sfo/SMOKE.jsonl` is what happened when each real seam was exercised after
the build, one line per check per attempt:

    {"seam":"anthropic-batch","check":"submit a one-request batch","level":"failed","detail":"exited 1: …","attempt":1,"at":"<ISO 8601>"}

A seam's result is its **highest attempt**: attempt 1 is the first run, each
later one follows a repair. `completed` means it did the whole job for real;
`accepted` means an async service took the request and completion was not
seen; `failed`; `skipped` with the reason in `detail`.

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

**Lead with what does not work.** A seam whose result is `failed` goes first of
all — the tool was run against the real thing and it did not work. Next, every
`high` finding that is not `repaired`: an independent review showed the
behaviour is wrong, and it still is. Then any
slice that failed or was skipped: that is the first thing in the document — which criteria are unmet, and what the person
cannot do as a result. Burying a gap under a list of what worked is the failure
this whole pipeline exists to prevent.

Then, in order:

1. **What this is and how to run it** — the actual commands, assuming nothing.
   `.sfo/INSTALL.json` says what sfo put on the person's PATH: each command,
   whether it was installed and where it resolves from a new terminal, or why
   not. Lead with the installed command itself (`ut-tower`, not `uv run
   ut-tower`); where one could not be installed, say why, and give the command
   that runs it from the project instead.
   If it calls a model, say which credential it needs and where it reads it
   from, and whether that call was ever made against the real service or only
   against a test double. A backend nobody has run is not verified, however
   many tests pass around it.
2. **Real seams** — a table of every seam in `.sfo/SERVICES.jsonl`: its
   result, what was checked, and for anything not `completed`, why (accepted
   but not seen to finish; irreversible with no test mode; no credential; over
   the smoke cap; no smoke test written). A seam listed in `.sfo/REVIEW.md` as
   missing from `.sfo/SERVICES.jsonl` goes in the table as never checked.
3. **What was not verified** — from `.sfo/VERIFY.jsonl`: any slice whose gate
   never reached a step, any archetype with no recipe, and anything the recipe
   for this archetype does not cover. State it plainly rather than omitting it.
   "Verified" here means exactly the steps that ran and exited 0.
4. **Review findings** — the rest of `.sfo/FINDINGS.jsonl`: what was repaired
   and the test that now guards it, what was reported but not repaired, and
   the `not_reproduced` claims, briefly, as the reviewer being wrong.
5. **Tests changed after the lock** — from `.sfo/CONTESTS.jsonl`, one entry per
   contest: the slice, the test, what the build agent claimed, and the ruling.
   Name every `amend_test` and every criterion rewritten from the person's
   answer, with the files changed. The suite was locked so that it could not
   quietly change; these are the times it did, and a reviewer should read each
   one. Records in `.sfo/VERIFY.jsonl` with `"trigger":"relock"` are slices
   re-graded after an amendment — say which of them failed and were rebuilt.
   Omit this section only if the file does not exist.
6. **Decisions worth reviewing** — pull from `.sfo/DECISIONS.jsonl`, `external`
   and `structural` first. These are the calls that are expensive to reverse and
   the ones most worth a human's attention.
7. **Coverage gaps** from `.sfo/REVIEW.md`.

Be accurate rather than reassuring. Someone reads this to decide whether to
trust the thing you built.

Write only `.sfo/SUMMARY.md`.
