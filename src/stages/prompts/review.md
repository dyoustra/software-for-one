Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, `.sfo/SERVICES.jsonl`, the test
suite, and the source.

You are auditing **coverage**, not correctness. The suite already checks that
the code does what the criteria say; your job is to find what nothing checks.

Look for:

- **Spec requirements with no criterion.** Something `SPEC.md` states as
  required that never became an acceptance criterion.
- **Criteria with no test.** A criterion id that appears in no test file.
- **Tests weaker than their criterion.** A criterion saying "at most 255 bytes
  when UTF-8 encoded" tested only with ASCII input; a determinism criterion
  tested with a single run.

- **Seams nobody listed.** Every external client or platform API the source
  imports should have a record in `.sfo/SERVICES.jsonl`. One that does not was
  never smoke-checked and its fake enforces nothing; name it.
- **Fakes looser than their service.** A constraint in `.sfo/SERVICES.jsonl`
  that the corresponding fake does not enforce.
- **A smoke test that looks irreversible.** A smoke test whose calls send,
  post, charge, or delete, for a seam whose `effect` says otherwise. This is
  the one finding that is about safety rather than coverage: lead with it.

Write `.sfo/REVIEW.md`: findings with severity, each naming the criterion or
spec section and what is missing. Say plainly if you find nothing — an audit
that manufactures findings to look useful is worse than one that reports a clean
result.

Do not modify tests or code. You are reading, not fixing.
