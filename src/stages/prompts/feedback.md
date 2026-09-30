Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, `.sfo/DECISIONS.jsonl`,
`.sfo/SUMMARY.md`, and `.sfo/PRESENTATION.json` and `.sfo/RENDERS.json` if
they exist. Then read the code.

This project was built and delivered, and the person who asked for it has used
it and has feedback, quoted at the end of these instructions. Act on it the way
a good engineer acts on a follow-up request: understand what they mean, make
the change, prove it with tests, and do not break anything that worked.

- **Change the code** to do what the feedback asks.
- **Add tests** for the new behaviour, as new files: `tests/test_feedback_*.py`,
  or `tests/feedback-*.test.ts` for `cli-node`. Make them check what the person
  asked for, not your implementation of it.
- **Update the criteria** the feedback changes. Reword, add, or drop lines in
  `.sfo/CRITERIA.jsonl` — keep ids of reworded criteria, and give new ones fresh
  `AC-` ids. The person's words are the authority here, over the original spec.
- **Never edit an existing test.** Those are what prove everything that worked
  still does. If one contradicts the feedback, contest it (described below)
  rather than working around it.
- If the tool has a look (`.sfo/PRESENTATION.json` says `visual`), make it look
  right on both a light and a dark terminal background: use the terminal's
  default foreground rather than hard-coded white or black, or paint your own
  background behind what you draw.

If this is **too big for one session** — it needs a new external service, or
rewrites most of the code — do not attempt it. Say so, and why, and change
nothing.

When you finish, write `.sfo/FEEDBACK_RESULT.json`:

    {"verdict":"done","summary":"<two or three sentences the person reads: what changed, and anything they should know>"}

or `{"verdict":"too_big","summary":"<why, and what a bigger follow-up would involve>"}`.

Run the gate commands at the end of these instructions before you finish.

Do not write to `.sfo/` other than `CRITERIA.jsonl`, appending decisions, and
`FEEDBACK_RESULT.json` or `CONTEST.json`.
