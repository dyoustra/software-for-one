Read `.sfo/IDEA.md` and `.sfo/RESEARCH.md`. Produce a specification.

**Write each file as you finish it, not all at the end.** Write `.sfo/SPEC.md` first and save it, then `.sfo/QUESTIONS.md`, then append to `.sfo/DECISIONS.md`. Stages get killed mid-run; partial output that a re-run can build on beats losing twenty minutes of work to a dropped connection.

Write `.sfo/SPEC.md` containing:
- **What this is** — one paragraph.
- **User stories** — what someone actually does with it.
- **Acceptance criteria** — a numbered list, each item independently checkable by a test. Write them so a machine can verify them: "the list persists across a page reload", not "persistence works well". These are the contract that later verification checks against, so vagueness here is the most expensive mistake you can make in this stage.
- **Out of scope** — what this deliberately does not do.
- **Stack** — the archetype and slot choices, with a one-line reason for any deviation from the defaults.

Write `.sfo/QUESTIONS.md` containing questions for the human. Split them under two headings, `## Blocking` and `## Preference`:
- **Blocking** — the answer changes the architecture; guessing wrong wastes the build.
- **Preference** — you have picked a defensible default; the human can override it.

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
    - blast_radius: local | structural | external

Write only those three files.
