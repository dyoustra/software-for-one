Read `.sfo/IDEA.md` and `.sfo/RESEARCH.md`. Produce a specification.

**Write each file as you finish it, not all at the end.** Write `.sfo/SPEC.md` first and save it, then `.sfo/QUESTIONS.md`, then append to `.sfo/DECISIONS.md`. Stages get killed mid-run; partial output that a re-run can build on beats losing twenty minutes of work to a dropped connection.

Write `.sfo/SPEC.md` containing:
- **What this is** — one paragraph.
- **User stories** — what someone actually does with it.
- **Acceptance criteria** — a numbered list, each item independently checkable by a test. Write them so a machine can verify them: "the list persists across a page reload", not "persistence works well". These are the contract that later verification checks against, so vagueness here is the most expensive mistake you can make in this stage.
- **Out of scope** — what this deliberately does not do.

Treat numbers and specifics in the idea as a sense of scale, not a spec. Design for the general case and make scale a parameter; if the architecture genuinely hinges on it, ask rather than assume.
- **Stack** — the archetype and slot choices, with a one-line reason for any deviation from the defaults.

Write `.sfo/QUESTIONS.md` containing questions for the human. Split them under two headings, `## Blocking` and `## Preference`:
- **Blocking** — the answer changes the architecture; guessing wrong wastes the build.
- **Preference** — you have picked a defensible default; the human can override it.

A decision that materially changes what the person will be charged is a question, not a default — even when you have a defensible answer. Cost is theirs to spend.

Format every question as:

    ### <question>
    - [ ] A — <option> — <tradeoff>
    - [ ] B — <option> — <tradeoff>
    - [ ] Other: ______

Aim for 5 to 10 questions total. Fewer than 5 means you are not thinking hard enough about what is genuinely ambiguous. More than 10 means you are pushing decisions to the human that you should own — for those, pick the defensible default and record it instead.

Append every default you chose to `.sfo/DECISIONS.md` in this format:

    ## <decision>
    - Chose: <what>
    - Considered: <alternatives>
    - Why: <reasoning>
    - decided_by: agent
    - blast_radius: local | structural | external

`decided_by` is required on every entry, never omitted. An absent field cannot be
distinguished from a forgotten one, so "the agent chose this" must be stated rather
than inferred from silence.

Write only those three files.
