Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, `.sfo/SERVICES.jsonl`,
`.sfo/DECISIONS.jsonl`, `.sfo/RENDERS.json` if it exists, the test suite, and
the source. You have not seen how
any of it was built, and that is the point: you are the adversarial review.

The gate has already checked that every slice's tests pass. Your job is what
the gate cannot see — code that passes its tests while the feature is hollow,
and whatever nothing tests at all. Default to skepticism.

Look for:

- **Hollow or wrong behaviour.** A criterion the tests pass while the code does
  not really meet it: a stub, a hard-coded answer, a flag that is parsed and
  then ignored, a setting that never reaches the thing it controls.
- **Spec requirements with no criterion**, **criteria with no test**, and
  **tests weaker than their criterion** — a byte limit tested only with ASCII,
  a determinism criterion tested with one run.
- **Seams nobody listed.** Every external client or platform API the source
  imports should have a record in `.sfo/SERVICES.jsonl`.
- **Fakes looser than their service.** A constraint in `.sfo/SERVICES.jsonl`
  that the corresponding fake does not enforce.
- **A smoke test that looks irreversible** — one whose calls send, post,
  charge, or delete, for a seam whose `effect` says otherwise. Lead with it.

**Look at it.** `.sfo/RENDERS.json` lists what the tool printed on a real
terminal for each of its presentation's invocations: the raw capture (`text`)
and, for a `visual` tool, screenshots on a light and a dark background (`light`,
`dark`), all relative to `.sfo/`. Open the screenshots and look. Output that
vanishes on one background, is cut off, wraps where it should not, or does not
look like what the spec describes is a `code` finding like any other — a
reproduction test for it can assert on the captured escape codes and text.

**Decisions.** A decision in `.sfo/DECISIONS.jsonl` with `"decided_by":"human"`
is the spec: the person chose it, so it is never a finding. One made by an agent
may be challenged — name it in `decisionId` and say why it is wrong.

Write `.sfo/FINDINGS.jsonl`, one object per line. It starts empty for this
review: number from `R-001`, and every finding is `"round":1`. Earlier reviews'
findings, if any, are in `.sfo/findings-history/` — read them for context, and
report again anything still true.

    {"id":"R-001","round":1,"severity":"high","kind":"code","criterionId":"AC-031","decisionId":null,
     "summary":"--resolution is never applied to the image bytes sent",
     "evidence":"send() always encodes the original bytes; nothing reads settings.resolution",
     "test":"tests/review/test_r001_resolution.py"}

- `severity` is `high` (the person would hit it and it breaks what they asked
  for), `medium`, or `low`.
- `kind` is `code` (the behaviour is wrong or hollow), `coverage` (a missing or
  weak test), `spec` (the spec or a criterion itself looks wrong or
  contradictory), `seam`, `safety`, or `test` — **a test or test helper that
  is itself wrong**: it cannot observe what it claims to, asserts the
  impossible, or checks the wrong file. Name it in `testFile`. A `test`
  finding goes to an independent adjudicator, which may amend the test; it is
  the only way a locked test gets fixed, so use it when a test, not the code,
  is what is broken.
- `criterionId`, `decisionId` and `testFile` are `null` when they do not apply.

**Every `high` + `code` finding must come with a test that reproduces it**,
under `tests/review/`, named for the finding — `tests/review/test_r001_*.py`,
or `tests/review/r001-*.test.ts` for `cli-node` — and named in `test`. It must
**fail against the code as it is now** and pass once the finding is fixed.
These are the only findings that get repaired, and your test is the whole of
how "fixed" is judged, so make it exact: assert what the criterion requires,
not an implementation detail. It is run before it counts; one that passes
already is recorded as not reproduced. Follow the suite's conventions — its
fixtures, its fakes, annotated test functions — because it has to pass the
same lint and type check as every other test. Other findings have `"test":null`.

Also write `.sfo/REVIEW.md` for the person: the findings in plain language, most
serious first.

Say plainly if you find nothing. An audit that manufactures findings to look
useful is worse than one that reports a clean result — and a fabricated `high`
finding costs a repair round.

Write only `.sfo/FINDINGS.jsonl`, `.sfo/REVIEW.md`, and files under
`tests/review/`. Anything else you change is reverted.
