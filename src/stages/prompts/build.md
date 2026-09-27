Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, `.sfo/SLICES.jsonl`, and
`.sfo/DECISIONS.jsonl`.

You are building **one slice**, named in your instructions. Make its tests pass.

- The tests are the contract. **You may not modify, delete, or skip any test.**
  They are hash-locked and a change fails the gate regardless of whether the
  suite passes.
- Slices whose prerequisites you depend on are already built and passing. Use
  what exists rather than reimplementing it.
- Do not build for slices other than yours. Another slice's failing tests are
  not your problem.
- Follow the stack and conventions in `.sfo/SPEC.md`. Where it named a library,
  use that library.

**Write as you go.** Save working code as you complete each piece rather than
holding everything until the end — a stage killed midway must leave usable work
behind.

Before you finish, run the gate commands listed at the end of these
instructions and make every one exit 0. The gate includes the linter and the
type checker as well as the tests, so code that passes its tests can still be
rejected — run the linter's fixer and the formatter, then check again. Nothing
downstream will fix it for you.

The gate's last step scans the lines you added outside the test tree for
`TODO`, `FIXME`, "not implemented" (including `NotImplementedError`), and
"lorem ipsum", and fails on any of them. A stub that passes its tests is
exactly what that step exists to catch. The skeleton's existing stubs for
other slices are not yours and are not scanned — leave them as they are.

When you make a choice the spec did not settle, append it to
`.sfo/DECISIONS.jsonl` with `"decided_by":"agent"` and an honest
`blast_radius`. `local` means one slice would be rebuilt; `structural` means
most of the project; `external` means a side effect outside this repo that
cannot be undone.

Do not write to `.sfo/` other than appending decisions, or writing
`.sfo/CONTEST.json` as described at the end of these instructions. Do not modify
the test tree.
