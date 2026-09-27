# Real Seams — Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-09-27
**Depends on:** `MODEL_ACCESS_SPEC.md` (credentials), `CONTEST_SPEC.md` (contesting a wrong smoke test)
**Precedes:** `PARALLEL_SLICES_SPEC.md`

---

## 1. Why

B11 passed 188 tests and delivered a tool whose first real batch submission was
rejected:

    requests.0.custom_id: String should have at most 64 characters

The hash used as `custom_id` was 128 characters long. Every test ran against a
fake transport that accepted any length, so none could fail on this. The
pipeline knew the risk: `SUMMARY.md` opened by saying the Anthropic transport,
Vision OCR and the Spotlight probe had **never executed**. It reported the gap
and delivered anyway, because no stage's job was to close it.

The fault is a fake that accepted inputs the real service would reject. Two
defences, sharing one list of services:

1. **Prevention:** fakes enforce the real service's documented rules, so a test
   fails where the real service would have.
2. **Detection:** a `smoke` stage exercises every real seam once, cheaply and
   harmlessly, before the build is reported. That catches what the list missed.

Prevention only covers the rules someone thought to write down. Detection
catches the rest.

## 2. The list of seams: `.sfo/SERVICES.jsonl`

One record per real seam, whether a network service or a platform API:

```json
{"id":"anthropic-batch","name":"Anthropic Message Batches API","kind":"network",
 "effect":"billed","testMode":null,
 "credential":{"name":"ANTHROPIC_API_KEY","covers":"anthropic_api_key"},
 "constraints":[
   {"rule":"each request's custom_id matches ^[a-zA-Z0-9_-]{1,64}$","source":"https://docs.anthropic.com/…/batches"},
   {"rule":"at most 100,000 requests or 256 MB per batch","source":"https://docs.anthropic.com/…"}],
 "smoke":{"checks":["submit a one-request batch","poll it to completion"],"maxCostUsd":0.01,"async":true}}
```

- **`kind`** is `network` or `platform`. Platform seams include macOS Vision
  OCR, Spotlight, the clipboard and notifications. They're mocked in tests just
  like network ones, and they're free to run for real.
- **`effect`** is one of `read_only`, `billed`, `reversible` or `irreversible`.
  This decides whether smoke may run the seam (§4.3).
- **`testMode`** is how to exercise an irreversible seam without the effect,
  such as Stripe's test keys, or null if the service has none.
- **`credential`** is the environment variable the tool reads. `covers` names
  the profile method that supplies it (`anthropic_api_key`), or is null for a
  credential the profile doesn't know about (§3).
- **`constraints`** each carry a `source`. A rule with no source is a guess,
  and a guess is how the 64 got written as 128.

**Who writes it:**
- `research` lists the services the idea will probably touch and fetches each
  one's documented limits.
- `spec` finishes the list against the actual design: it adds seams, sets each
  `effect`, and removes services the design doesn't use.
- It's validated with zod on read, like every other artifact.

## 3. Credentials

- If the profile covers a credential (the Anthropic key today), it's resolved
  the way sfo's own runs resolve it (`MODEL_ACCESS_SPEC.md` §4).
- Any other credential becomes a `blocking` clarify question: where is it
  (`keychain:<service>` or `env:<VAR>`), or skip the seams that need it.
- The answer is stored as a **reference** in `.sfo/CREDENTIALS.json`, never
  the value. It's resolved only inside the smoke stage, and passed only to the
  smoke process, as the variable the tool reads.
- A credential that doesn't resolve at smoke time means that seam is skipped,
  and the report says so and why.

## 4. The two defences

### 4.1 Fakes that enforce the rules (test-write)

For every `network` seam, test-write builds its fake so that it **rejects**
any input breaking one of that seam's `constraints`, and raises the same kind
of error the real client would. Each constraint also gets a test that runs
production code through the fake with realistic inputs. That's the test that
would have failed on a 128-character hash.

A constraint the fake can't enforce (a rate limit, say) is listed in a comment
next to the fake, saying why, so review can see it.

### 4.2 Smoke tests (test-write, locked, run later)

- They live in `tests/smoke/`, written blind alongside the rest of the suite
  and **locked with it**, so no build agent can shape them.
- The slice gate skips them. The recipe for each archetype gains a
  `--ignore tests/smoke` (pytest) or `--exclude 'tests/smoke/**'` (vitest) on
  its test step, so a slice is never graded on a real network call.
- **One test per check** in `SERVICES.jsonl`. Each one uses production wiring,
  the real dependencies and not the fakes, through the same interface the rest
  of the suite imports.
- **Synthetic inputs only.** test-write creates small realistic fixtures under
  `tests/smoke/fixtures/`, such as a PNG it renders with known text, so an OCR
  check can compare against what it expects. Each test copies its fixtures into
  a temporary directory. None of your files are read or sent anywhere.
- **Results are reported through a file, not only an exit code.** Each test
  appends one line to the file named by `$SFO_SMOKE_RESULTS`:

      {"seam":"anthropic-batch","check":"submit a one-request batch","level":"accepted","detail":"batch msgbatch_… accepted","costUsd":0.0007}

  `level` is one of:
  - `completed`: the seam did its whole job.
  - `accepted`: an async service took the request but didn't finish within
    the wait.
  - `failed`
  - `skipped`, with the reason in `detail`.

  A test that raises is `failed` whatever it wrote.

### 4.3 What smoke may run

| effect | smoke runs it? |
|---|---|
| `read_only` | yes |
| `billed` | yes, within the cap (§5.3) |
| `reversible` | yes. The test undoes the effect in a `finally`, and verifies the undo |
| `irreversible` | only through `testMode`. With no test mode it has no smoke test, and it's reported as unverified |

`spec` sets the effect, so a wrong label is where this could fail. `review`
reads the smoke tests against `SERVICES.jsonl` and flags any test whose calls
look irreversible for a seam labelled otherwise.

## 5. The `smoke` stage

`PIPELINE_STAGES` gains `smoke` between `build` and `review`. It's mostly
mechanical: an agent runs only in the repair pass.

### 5.1 Run

1. Check the test lock covers `tests/smoke/` and still matches.
2. Resolve credentials (§3). Seams whose credential is missing are recorded as
   `skipped`.
3. Choose checks within the cap (§5.3).
4. Run the archetype's test runner on `tests/smoke/` alone. It gets
   `SFO_SMOKE_RESULTS` and the resolved credentials in its environment, and
   nothing else from sfo's.
5. Read the results file and the exit code. Record `.sfo/SMOKE.jsonl`, one
   line per check per run, with the attempt number.

### 5.2 Async seams: accepted, then a bounded wait

A check on an async service passes at `accepted` once the service takes the
request. That's the level today's bug would have failed at, since it was
rejected on submit. The check then polls for up to `SMOKE_ASYNC_WAIT`
(5 minutes). If the work finishes, the check is `completed`. If not, it stays
`accepted` and the report says completion wasn't verified. The pipeline never
waits for hours.

### 5.3 Cost

- The default cap is **$2 per smoke run**, set per project with
  `sfo budget <id> --smoke <usd>`. It's shown in the plan's estimate and counts
  toward the project's budget.
- The cap applies to **declared** costs: each seam's `smoke.maxCostUsd`. Checks
  are chosen in `SERVICES.jsonl` order until the next one wouldn't fit. The
  rest are `skipped`, with "over the smoke cap" as the reason.
- Actual costs, where the service reports them, come back through
  `costUsd` in the results and go into `COST.jsonl` as stage `smoke`, with
  `billing: "api"`.
- Metering is only as good as the declarations. This spec says so, rather than
  claiming a hard ceiling it doesn't have.

### 5.4 Repair pass

If any check is `failed`:

1. Run a build agent as stage `smoke-repair`. It gets the failing checks, their
   `detail`, and the tail of the runner's output. The prompt is the build
   prompt with the smoke failure in place of a slice's previous failure. It may
   change production code, never tests.
2. Its gate is the **whole** suite (every slice's tests, lint and typecheck),
   not one slice. A repair that fixes a seam by breaking a slice is rejected.
3. Rerun the failed smoke checks.
4. Allow two attempts, the same as a slice.
5. The contest channel applies. A smoke test can be wrong too (its fixture, or
   its idea of the service), and the repair agent gets one contest for the
   smoke suite, under the id `SMOKE`.

If failures remain, the pipeline continues to review and deliver. Nothing
parks. You decided that a human is asked only at clarify, and a failing seam
is reported, not hidden.

## 6. Reporting

- `deliver` reads `SMOKE.jsonl` and `SERVICES.jsonl`. **Any `failed` seam
  leads the summary**, above everything else.
- SUMMARY's "What was not verified" becomes a table covering every seam: its
  level, what was checked, and why anything wasn't run (irreversible with no
  test mode, no credential, over the cap, accepted but not completed). The
  "never executed" disclaimer from B11 becomes a checklist that either passed
  or explains itself.
- A seam in the design that has no `SERVICES.jsonl` record is also listed.
  `review` compares the imports of external clients against the list and names
  any it can't match.

## 7. Out of scope

- **Running on your real data.** Synthetic fixtures only, as decided.
- **Load, rate-limit or performance testing.** Smoke is "does it work at all".
- **Other platforms.** Smoke runs on the machine sfo runs on. A seam that only
  exists elsewhere (Windows APIs, say) is `skipped`.
- **Checking a service's documentation for accuracy.** The fake enforces what
  the docs say, and smoke catches where the docs and reality differ.

## 8. Build order

1. `SERVICES.jsonl` and `CREDENTIALS.json`: schemas, reading, writing. Update
   the research and spec prompts.
2. Recipe changes, so the slice gate skips `tests/smoke/`. Add a test-write
   prompt section covering constraint-enforcing fakes and smoke tests.
3. The `smoke` stage: lock check, credential resolution, cap selection,
   running, parsing results, `SMOKE.jsonl`.
4. The repair pass, with the whole-suite gate and the `SMOKE` contest.
5. Update the deliver and review prompts. `sfo status` notes failed seams.
6. Rebuild `shotname` and confirm the batch seam would have failed at
   `accepted`, both before and after the `custom_id` fix.

## 9. Tests to write

- `SERVICES.jsonl` validation, including a constraint with no `source` being
  rejected.
- The slice gate never collects `tests/smoke/` (for both archetypes).
- The smoke stage refuses a smoke suite missing from the lock, or changed
  since it was locked.
- Credential resolution: a profile-covered credential, a Keychain reference,
  an env reference, and a missing one leading to `skipped`. No credential
  value reaches `SMOKE.jsonl`, a log, or the environment of anything but the
  smoke runner.
- Cap selection: checks are chosen in order until the next doesn't fit, and
  the rest are recorded as `skipped` for being over the cap.
- Result parsing: every `level`, a test that raised despite writing `accepted`
  (so `failed`), and a missing results file.
- Irreversible seams with no `testMode` get no check, and appear in the report.
- Repair runs on `failed`, is gated on the whole suite, stops after two
  attempts, and continues to review either way.
- A smoke contest uses the id `SMOKE` and follows the contest rules.
- Cost records for stage `smoke` carry `billing: "api"`.
