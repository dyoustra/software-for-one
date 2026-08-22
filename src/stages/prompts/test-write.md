Read `.sfo/SPEC.md`, `.sfo/ARCHETYPE.json`, `.sfo/CRITERIA.jsonl`, and
`.sfo/SLICES.jsonl`.

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

**These tests are expected to fail.** Nothing implements them yet. A failing
test means the code is missing, which is correct. What must NOT happen is a test
that *errors* — an import that cannot resolve a module you never create, a
reference to a symbol nothing defines, a syntax error. Write tests that fail
cleanly against a skeleton.

Write only files under the test tree. Do not create source modules, do not write
a skeleton, do not modify anything under `.sfo/`.
