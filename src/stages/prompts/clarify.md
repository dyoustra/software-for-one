Read `.sfo/SPEC.md`, `.sfo/QUESTIONS.md`, and `.sfo/ANSWERS.md`.

The human has answered the questions. Fold their answers into `.sfo/SPEC.md`, editing it in place — do not write a new document. Where an answer contradicts a default you previously chose, the answer wins.

Append each answered question to `.sfo/DECISIONS.md` in the standard format, with
`- decided_by: human (ANSWERS.md)`. Every entry carries `decided_by` — entries you
decide yourself use `- decided_by: agent`. Never omit the field.

If an answer opens a genuinely new ambiguity that would change the architecture, add it to `.sfo/QUESTIONS.md` under `## Blocking` and stop. Otherwise leave `.sfo/QUESTIONS.md` alone.

Write only `.sfo/SPEC.md`, `.sfo/QUESTIONS.md`, and `.sfo/DECISIONS.md`.
