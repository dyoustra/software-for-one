Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, `.sfo/QUESTIONS.json`, and `.sfo/ANSWERS.json`.

`.sfo/ANSWERS.json` is `{"answers":[{"questionId":"Q-001","answer":"<free text>"}]}`. Each `answer` is the raw text the human typed, not an option key. "A, but with a `--materialize` flag" is not "A" — the qualification is a real requirement and must survive into `.sfo/SPEC.md` or `.sfo/CRITERIA.jsonl`. An answer that names no option at all is still an answer; take it at its word.

Fold the answers into `.sfo/SPEC.md`, editing it in place — do not write a new document. Where an answer contradicts a default you previously chose, the answer wins.

**Write each file as you finish it, not all at the end.** Stages get killed mid-run; partial output that a re-run can build on beats losing the work to a dropped connection.

Update `.sfo/CRITERIA.jsonl` wherever an answer changes what must be true — adding criteria, removing ones the answer rules out, rewording ones it narrows. Rewrite the whole file, one JSON object per line, no wrapping array:

    {"id":"AC-001","group":"Enumeration and file identification","text":"Given a directory containing a file whose name embeds U+202F, that file appears in the candidate set."}

Keep a criterion's `id` and `group` unchanged when you reword its `text` — the id is how later stages track the same requirement across revisions. New criteria get fresh `AC-` ids that no line in the file has used, including ids freed by criteria you just removed. Every `text` stays one self-contained sentence a test can check, readable alone without its group heading.

Append one record per answered question to `.sfo/DECISIONS.jsonl`, one object per line:

    {"id":"D-014","decision":"<short name>","chose":"<what the human chose, in their words>","considered":"<the options offered>","why":"<their reasoning, or the question this settles>","decided_by":"human","blast_radius":"local","at":"<ISO 8601>"}

`decided_by` is `human` for every one of these — the human decided them, not you. Any decision you make yourself in this stage is a separate record with `"decided_by":"agent"`. Never omit the field: absence cannot be distinguished from a bug. Give each record an `id` that continues past the highest `D-` already in the file. `blast_radius` is exactly one of `local`, `structural`, `external`. `at` must be a real ISO 8601 timestamp.

Where an answer says where a credential lives, record it in
`.sfo/CREDENTIALS.json`, keyed by the environment variable the seam in
`.sfo/SERVICES.jsonl` reads, merged with whatever the file already holds:

    {"GITHUB_TOKEN":{"source":"keychain","service":"github-token"},
     "OPENWEATHER_KEY":{"source":"env","var":"OPENWEATHER_KEY"}}

A reference only — never a value, even if the person typed one; if they did,
record nothing and add a follow-up question asking where it is stored instead.
An answer of "skip" records nothing: that seam's smoke check reports it was
skipped for want of a credential.

If an answer changes what is being built or with what, rewrite `.sfo/ARCHETYPE.json` to match — `{"archetype":"<what it is, in words>","why":"..."}` — and the **Stack** section of `.sfo/SPEC.md`. If it is unchanged, leave the file alone.

If an answer opens a genuinely new ambiguity that would change the architecture, add a question to `.sfo/QUESTIONS.json` and stop. Never add one about how the person pays for model calls — `.sfo/ACCESS.json` already answers that. Otherwise leave `.sfo/QUESTIONS.json` alone.

When you do add one, rewrite the whole file: carry **every** existing question through unchanged — same `id`, `section`, `text`, `context`, and `options` — and append the new one with a fresh `Q-` id that no existing question uses. Duplicate ids are rejected and the stage fails, so never reuse the id of the question whose answer prompted the new one.

    {"questions":[
      {"id":"Q-001","section":"blocking","text":"<question>","context":"<why this matters, 1-2 sentences>",
       "options":[{"key":"A","label":"<option>","tradeoff":"<what it costs>"},
                  {"key":"B","label":"<option>","tradeoff":"<what it costs>"}]}
    ]}

`section` is exactly `blocking` or `preference`; a new question raised here is `blocking`. At least two options per question. Do not add an "Other" option — free text is always accepted.

Every one of these files is schema-validated when read. A malformed line fails the next stage rather than being skipped, so emit strict JSON: double quotes, no trailing commas, no comments, and one complete object per line in the `.jsonl` files.

Write only `.sfo/SPEC.md`, `.sfo/ARCHETYPE.json`, `.sfo/CRITERIA.jsonl`, `.sfo/QUESTIONS.json`, `.sfo/CREDENTIALS.json`, and `.sfo/DECISIONS.jsonl`. Never write `.sfo/ANSWERS.json`.
