Read `.sfo/CRITERIA.jsonl` and the test suite.

Run the suite. Every test is expected to **fail** — nothing is implemented yet,
and that is correct. Your job is to fix only the tests that **error**:

- an import that cannot resolve
- a reference to a symbol nothing defines
- a syntax error
- a fixture that raises during setup

Create the minimum skeleton needed for the suite to load and fail cleanly: empty
modules, function stubs that raise `NotImplementedError`, package `__init__`
files. Nothing that could make a test pass.

**Do not change what a test asserts.** If a test errors because it imports
`shotname.plan`, create that module — do not delete the import. If a test looks
wrong to you, leave it: it is the contract, and the build stage will have to
satisfy it. Weakening a test here defeats the entire point of writing tests
before the implementation.

When you are done, every test must fail rather than error. If you cannot reach
that state — a missing dependency, a criterion you cannot express as a loadable
test — stop and say exactly what is blocking. Do not iterate; report.

Write only skeleton source files. Do not modify anything under `.sfo/`.
