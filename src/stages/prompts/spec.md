Read `.sfo/IDEA.md` and `.sfo/RESEARCH.md`. Produce a specification.

**Write each file as you finish it, not all at the end.** Write `.sfo/SPEC.md` first and save it, then `.sfo/CRITERIA.jsonl`, then `.sfo/QUESTIONS.json`, then append to `.sfo/DECISIONS.jsonl`. Stages get killed mid-run; partial output that a re-run can build on beats losing twenty minutes of work to a dropped connection.

Write `.sfo/SPEC.md` containing:
- **What this is** — one paragraph.
- **User stories** — what someone actually does with it.
- **Acceptance criteria** — each item independently checkable by a test. Write them so a machine can verify them: "the list persists across a page reload", not "persistence works well". These are the contract that later verification checks against, so vagueness here is the most expensive mistake you can make in this stage. They live in `.sfo/CRITERIA.jsonl`, described below; `.sfo/SPEC.md` refers to them by id.
- **Out of scope** — what this deliberately does not do.

Treat numbers and specifics in the idea as a sense of scale, not a spec. Design for the general case and make scale a parameter; if the architecture genuinely hinges on it, ask rather than assume.
- **Stack** — the archetype and slot choices, with a one-line reason for any deviation from the defaults.

Write `.sfo/CRITERIA.jsonl` — one JSON object per line, no wrapping array:

    {"id":"AC-001","group":"Enumeration and file identification","text":"Given a directory containing a file whose name embeds U+202F, that file appears in the candidate set."}

`id` is `AC-` plus a zero-padded number, unique across the file. `group` is the
heading the criterion belongs under; keep related criteria in the same group and
order groups the way a person would build them. `text` is one self-contained
sentence that a test can check — it must make sense read alone, without the
group heading.

`.sfo/SPEC.md` keeps the prose and refers to criteria by id rather than
restating them.

Questions for the human go in `.sfo/QUESTIONS.json`. Every question is either
`blocking` or `preference`:
- **Blocking** — the answer changes the architecture; guessing wrong wastes the build.
- **Preference** — you have picked a defensible default; the human can override it.

A decision that materially changes what the person will be charged is a question, not a default — even when you have a defensible answer. Cost is theirs to spend.

This is the **only** point at which the human is asked anything. Nothing later
stops to check the build plan or confirm scope, so a question you decline to ask
here is a question that never gets asked. Ambition is the one most often missed:
where the idea admits a small version and a thorough one, the difference is the
person's money and their answer, not yours.

Write `.sfo/QUESTIONS.json`:

    {"questions":[
      {"id":"Q-001","section":"blocking","text":"<question>","context":"<why this matters, 1-2 sentences>",
       "options":[{"key":"A","label":"<option>","tradeoff":"<what it costs>"},
                  {"key":"B","label":"<option>","tradeoff":"<what it costs>"}]}
    ]}

`section` is exactly `blocking` or `preference`. At least two options per
question. Do not add an "Other" option — free text is always accepted.

Aim for 5 to 10 questions total. Fewer than 5 means you are not thinking hard enough about what is genuinely ambiguous. More than 10 means you are pushing decisions to the human that you should own — for those, pick the defensible default and record it instead.

Append to `.sfo/DECISIONS.jsonl`, one object per line:

    {"id":"D-001","decision":"<short name>","chose":"<what>","considered":"<alternatives>","why":"<reasoning>","decided_by":"agent","blast_radius":"local","at":"<ISO 8601>"}

`decided_by` is required on every record, never omitted — absence cannot be
distinguished from a bug. `blast_radius` is exactly one of `local`,
`structural`, `external`. `at` must be a real ISO 8601 timestamp.

Append one record for every default you chose.

Every one of these files is schema-validated when read. A malformed line fails
the next stage rather than being skipped, so emit strict JSON: double quotes,
no trailing commas, no comments, and one complete object per line in the
`.jsonl` files.

Write only `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, `.sfo/QUESTIONS.json`, and
`.sfo/DECISIONS.jsonl`.

Once you have chosen the stack, rewrite the project's root `.gitignore` for it —
dependency directories, build output, caches, virtual environments, and anything
else a build would generate. Keep the existing `.sfo/logs/` line. The build stage
commits with `git add -A`, so anything missing from this file ends up in history
permanently.
