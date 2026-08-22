Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, and `.sfo/SLICES.jsonl`.

Write the test suite. **No implementation exists yet, and you must not write
any.** You are writing the contract the implementation will have to satisfy.

**One test file per slice**, named for the slice id and name — for a Python
project, `tests/test_s01_enumeration.py`. The build stage runs one slice at a
time and scopes the test run to that slice's file, so this mapping is what makes
slicing work.

Every criterion in a slice gets at least one test. Name each test so the
criterion it covers is obvious, and put the criterion id in the test's docstring
or a comment. A criterion with no test is a hole in the contract that the review
stage will find.

**You are designing the interface.** When you write `from shotname.plan import
plan_renames`, you are deciding that module and that signature exist. Choose
names and shapes a competent developer would choose, keep the surface small, and
be consistent across slices — the build stage has to produce exactly what you
import.

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
