Read `.sfo/SPEC.md`, `.sfo/ARCHETYPE.json`, `.sfo/CRITERIA.jsonl`,
`.sfo/SLICES.jsonl`, and `.sfo/SERVICES.jsonl`.

Write the test suite. **No implementation exists yet, and you must not write
any.** You are writing the contract the implementation will have to satisfy.

**One test file per slice**, and the file name must contain the slice id — for
slice `S-01`, `tests/test_s01_enumeration.py` or `tests/s01-enumeration.test.ts`.
The build stage runs one slice at a time and finds that slice's tests by
matching the slice id against the file name, ignoring case and separators, so
this naming is what makes slicing work.

Get it wrong and the build refuses to start: it checks before spending anything
that every slice in `.sfo/SLICES.jsonl` has a file named for it, and stops with
the ones it could not find. `S-01` is matched by `test_s01_*`, `s01-*`,
`test-s-01-*`; it is not matched by `test_enumeration.py`, `test_slice1.py`, or
`test_s1_*`. Use the id exactly as `.sfo/SLICES.jsonl` spells it. Splitting one
slice across several files is fine as long as every one of them carries the id.

Every criterion in a slice gets at least one test. Name each test so the
criterion it covers is obvious, and put the criterion id in the test's docstring
or a comment. A criterion with no test is a hole in the contract that the review
stage will find.

**You are designing the interface.** When you write `from shotname.plan import
plan_renames`, you are deciding that module and that signature exist. Choose
names and shapes a competent developer would choose, keep the surface small, and
be consistent across slices — the build stage has to produce exactly what you
import.

**Keep the dependencies small and real.** Prefer the standard library and the
archetype's own test runner — `pytest` for `cli-python`, `vitest` for
`cli-node`. Every third-party package you import has to be a real, installable
one: the next stage writes the project manifest from what your tests actually
import, and it cannot declare a library you invented. Do not import the test
runner's plugins unless a criterion genuinely needs them.

Annotate your test functions with their return types (`def test_x() -> None:`
in Python). The verification gate type-checks the whole tree in strict mode,
tests included, and an unannotated test fails every slice's gate rather than
just its own.

Build any fixtures the criteria imply. `.sfo/SPEC.md` may already describe the
fixture corpus it expects; if so, build that. Fixtures are code and go in the
test tree.

**Fakes must be as strict as the real thing.** For every `network` seam in
`.sfo/SERVICES.jsonl`, the fake you build rejects any input that breaks one of
that seam's `constraints`, raising the kind of error the real client raises. A
fake that accepts what the service rejects is how a whole suite passed while
the first real request was refused. For each constraint, also write a test that
drives production code through the fake with realistic inputs — the test that
would have caught a 128-character id sent where 64 is the limit. A constraint a
fake genuinely cannot enforce (a rate limit) gets a comment beside the fake
saying so.

**Smoke tests: one file per seam, under `tests/smoke/`.** These run later,
against the real service or platform API, and the slice gate never runs them.

- Name each file for its seam id, dashes as underscores:
  `tests/smoke/test_smoke_anthropic_batch.py`, or
  `tests/smoke/smoke_anthropic_batch.test.ts` for `cli-node`. A seam with no
  file is reported as never checked.
- Each file performs that seam's `smoke.checks` through **production wiring**
  — the real client, not a fake — using the same interface the rest of your
  suite imports.
- **Synthetic inputs only.** Build small, realistic fixtures under
  `tests/smoke/fixtures/` (render a PNG with known text for an OCR check) and
  copy them into a temporary directory before use. Never read the person's
  files.
- The credential arrives in the environment variable `credential.name` names.
  Nothing else is provided.
- **Report every check** by appending one JSON line to the file named by the
  environment variable `SFO_SMOKE_RESULTS`:

      {"seam":"anthropic-batch","check":"submit a one-request batch","level":"accepted","detail":"batch msgbatch_… accepted","costUsd":0.0007}

  `level` is `completed` when the seam did the whole job, `accepted` when an
  async service took the request but had not finished, `failed`, or `skipped`
  with the reason in `detail`. Put the real cost in `costUsd` when the service
  reports usage. Write a small helper for this rather than repeating it.
- For an `async` seam, poll for at most `SFO_SMOKE_ASYNC_WAIT_SECONDS` seconds,
  then report `accepted` if it has not finished — never wait longer.
- A `reversible` seam undoes its effect in a `finally` and checks the undo.
  An `irreversible` one is exercised only through its `testMode`; with none,
  write no smoke test for it.
- A failed assertion fails the seam whatever was reported first, so assert what
  matters: that the real response parses into what production code expects.

**These tests are expected to fail.** Nothing implements them yet. A failing
test means the code is missing, which is correct. What must NOT happen is a test
that *errors* — an import that cannot resolve a module you never create, a
reference to a symbol nothing defines, a syntax error. Write tests that fail
cleanly against a skeleton.

Write only files under the test tree. Do not create source modules, do not write
a skeleton, do not modify anything under `.sfo/`.
