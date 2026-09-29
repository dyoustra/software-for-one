# Feedback and Drafts — Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-09-29
**Prompted by:** "ut-tower looks nothing like the actual UT Tower", after delivery

---

## 1. `sfo feedback <id> "…"`: a follow-up at the size of a prompt

A change to a finished project should cost about what it would in a Claude
Code session: one or two prompts, not a pipeline.

1. **Record it.** Your words go to `.sfo/FEEDBACK.jsonl` as entry *n*.
2. **One agent session** (`feedback-<n>`), with the whole project and your
   words. It may:
   - change the code;
   - **add** tests for the new behaviour, as new files only;
   - reword, add or drop the criteria your feedback changes. Those changes are
     recorded as `decided_by: "human"`, because they're your words.

   It may **not** edit an existing locked test. If one contradicts your
   feedback, it files a contest (`FEEDBACK-<n>`), which goes to the
   adjudicator, and the session continues.
3. **One gate:** every passed slice's tests, plus the new tests, lint,
   typecheck and the anti-gaming scan. Existing locked tests must be
   unchanged. If the gate fails, there's one more attempt with the gate output
   and the code left in place. If that fails too, the changes are discarded
   and reported.
4. **Too big for one session?** Examples are a new external service, or
   rewriting most of the code. The agent says so in `FEEDBACK_RESULT.json`
   (`"verdict":"too_big"`) instead of attempting it, and nothing changes.
5. **When it passes:** the new tests are locked and the change is committed as
   `feedback(<n>): …`. Then the tool is reinstalled, the screenshots are
   redrawn, `SUMMARY.md` gets a "Changes after delivery" entry, and you get a
   notification.

It runs detached like `sfo run`, with `--attach` to watch. Run it again for
the next round.

**Trade-off:** the same agent writes the new tests and the code, which the
main pipeline deliberately avoids. For a small follow-up that's accepted.
The old locked suite guards against regressions, and your eyes on the new
screenshots are the real check.

## 2. Drafts at clarify, only when the look matters

When `PRESENTATION.json` is `visual` **and** getting the look right is part of
the point, such as a drawing of something real or a layout the person will
judge by eye, spec also:

- draws **2–3 candidate drafts**, based on reference material research found
  (photos, diagrams), as ANSI text in `.sfo/drafts/<A|B|C>.txt`;
- asks one `blocking` question, "Which of these looks right?", with the
  drafts as options, plus free text for "none, because…".

After spec, sfo draws each draft on a light and a dark background
(`.sfo/drafts/<X>-light.png`, `-dark.png`). `sfo answer` lists the images and
opens them on macOS. The chosen draft is what test-write's snapshot tests
lock in. A tool whose look is incidental gets no drafts.

## 3. Tests to write

- A feedback entry is recorded, and runs one agent session with the words in
  its prompt.
- A new test file is accepted and locked. An edit to a locked test fails the
  gate.
- A failed gate gets one retry with its output, and then the work is
  discarded.
- `too_big` changes nothing and is reported.
- On success: a commit, criteria decisions recorded as `human`, the tool
  reinstalled, the screenshots redrawn, a SUMMARY entry, and a notification.
- Drafts are drawn after spec when present, and `sfo answer` lists them.
