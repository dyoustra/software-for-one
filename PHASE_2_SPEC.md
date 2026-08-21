# Phase 2 — Design Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-08-21
**Depends on:** `SOFTWARE_FOR_ONE_SPEC.md` (v1 design), `SOFTWARE_FOR_ONE_PLAN.md` (Phase 1), `docs/RUNBOOK.md` (first real run)

---

## 1. What Phase 2 is

Phase 1 turns an idea into a reviewed `SPEC.md`. Phase 2 turns that spec into **working, verified software**.

Phase 1 answered the question that gated this work: *are the generated acceptance criteria machine-checkable?* On the first real run they were — 43 of them, several specifying their own assertion mechanism. Phase 2 is the half that consumes them.

The risk moves with it. Everything Phase 1 validated was about *planning* quality, where a bad output is a document you can read. Phase 2 is where "reports success for work it did not do" becomes expensive and unobservable, because nobody is watching for two hours.

## 2. The pipeline

```
… clarify → plan → estimate → test-write → test-repair
          → [ build slice → verify slice ] x N
          → review → deliver
```

| Stage | Reads | Writes | Human? |
|---|---|---|---|
| `plan` | SPEC, CRITERIA | `PLAN.md`, slice groups | — |
| `estimate` | PLAN, CRITERIA | `ESTIMATE.md` | **yes, if over budget** |
| `test-write` | CRITERIA | test files | — |
| `test-repair` | tests + skeleton | fixed tests | — |
| `build` xN | tests for slice *i* | code | — |
| `verify` xN | repo | `VERIFY.md` | — |
| `review` | SPEC + test suite | `REVIEW.md` | — |
| `deliver` | everything | `SUMMARY.md`, repo | — |

A second, rougher `estimate` runs immediately after `triage`, gating the front half.

## 3. Tests are written before code, by an agent that never sees it

This is the load-bearing decision. `test-write` reads the acceptance criteria and writes the test suite with no implementation in existence. Three consequences, and they are the design:

**Tests are the interface contract.** When `test-write` writes `from shotname.plan import plan_renames`, the build stage must produce exactly that module and signature. Interface design therefore happens before implementation — the good half of TDD — and it is deliberate rather than incidental.

**The build agent cannot shape its own target.** The spec's original design had the build agent writing its own tests, with an adjudicator policing changes. That is the fox guarding the henhouse: the agent deciding what "done" means also decides what "tested" means. Writing tests first, blind, removes the conflict rather than policing it.

**Tests are locked after `test-repair`.** See below.

## 4. A correct test-first suite fails; a broken one errors

The distinction is mechanical and needs no model judgment:

- A test that **fails** means the code is missing. That is the expected, correct state before the build runs.
- A test that **errors** — an import that does not resolve, a symbol nothing defines, a syntax error — is structurally broken. The test itself is wrong.

`test-repair` is **one pass**: run against a bare skeleton, fix everything that errors, re-run, confirm zero errors remain. If any do, **fail the stage loudly** — something is wrong that repair cannot reach (a missing dependency, an incoherent criterion) and a human should see it. It does not iterate; iterating invites oscillation, fixing one import while breaking another. After it passes, **tests are locked**.

Locked means enforced, not requested. `verify` hashes every test file after `test-repair` and re-checks the hashes on each run; a changed test file fails the gate outright, regardless of whether the suite passes. Today's session showed prompt instructions get followed unevenly under pressure, and "do not weaken the tests" is exactly the instruction an agent under pressure reinterprets. The gate cannot be a request.

This is why Phase 2 ships **no test-change adjudicator**. The spec designed one because it assumed the build agent authored tests and would need to correct them. The mechanical repair pass removes the structural cases, which is most of the demand. Build the adjudicator when there is evidence it is needed — an adjudicator that sees three cases a year is untested machinery pretending to be a safeguard.

## 5. The build is sliced by the pipeline, not by the agent

**`plan` refines the spec's grouping rather than inventing one.** The spec stage already clusters criteria into coherent sections as a side effect of organising them — the first real run produced nine (`Enumeration`, `Name generation`, `Collision handling`, `Dry run and apply`, `Journal and undo`, `Abstention`, `Failure modes`, `Metadata`, `Sampling`) while holding the research and the whole design in context, which is more than `plan` will ever have. `plan` merges groups too small to justify a build invocation, splits ones that sprawl, and declares prerequisites. The spec's groups are organised for human readability rather than build tractability, so they are a strong default, not the final answer.

`build` runs once per slice; `verify` runs after each; **each passing slice commits**.

**Slices declare prerequisites; a failed slice skips its dependents.** Not a full dependency graph — parallelism is moot with one build agent, and the block-delivery-on-dependency case went away with partial delivery. What remains is cost: attempting `journal` after `collisions` failed burns a slice to fail again. Skipping also makes the summary honest — "collisions failed; journal skipped because it depends on collisions" rather than two apparently independent failures.

The argument is checkpointing, and it is empirical rather than theoretical: the first real run lost a 336-second, $1.25, 24-turn research stage to a dropped VPN and wrote zero artifacts. A crash in a sliced build costs one slice.

Secondary benefits: cost is attributable per slice, failures are localised, and a slice is a tractable unit of work in a way that "43 failing tests" is not.

**`verify` runs the whole suite each time**, but only *requires* the current slice plus previously-green ones. A slice that breaks an earlier slice fails the gate.

## 6. Partial delivery is a first-class outcome

Two slices fail after their retries, four pass. The project delivers: the repo, plus a `SUMMARY.md` that **leads with what does not work** and names the unmet criteria by id.

Most side projects are useful at 80%. A screenshot renamer that cannot handle collisions still renames screenshots. Failing the whole project throws away five working slices because one failed, and the failing slice is often the least important.

The honesty requirement is absolute: the summary leads with the gap. Burying it under what worked reproduces exactly the failure this product exists to prevent.

**The budget ceiling uses this same path.** One behavior, not two.

## 7. Review audits coverage, not code

With tests written blind from the criteria, re-checking code against criteria is largely redundant — the suite already does it. The gap tests **cannot** see is the requirement that never became a test.

So `review` reads `SPEC.md` against the **test suite**, hunting for:
- spec requirements with no corresponding criterion,
- criteria whose test asserts something weaker than the prose,
- criteria with no test at all.

It reads two documents rather than a codebase, which makes it cheaper than the original design and pointed at a different failure mode.

## 8. Archetypes supply verify recipes, not stacks

The first real run settled this. The spec stage chose Python over a Swift-native build because `ocrmac` exposes per-line OCR confidence and bounding boxes that a Swift CLI shelling out would have to re-plumb. That is a better decision than any default, and it was only available to a stage holding the research.

So the registry does not dictate the stack. It supplies the **verify recipe** per slot option — `ruff check`, `mypy --strict`, `pytest` — and the scaffold fragment.

**The spec stage picks slots freely.** Where the registry has a recipe, that gate runs. Where it does not, verification degrades to what can be run and `SUMMARY.md` names exactly which gates did not run. Never a silent downgrade.

**First archetype: `cli`.** Chosen because the validated idea is a CLI. The spec's original `app`/Expo choice was made before any real ideas existed; the actual backlog is 2 CLIs and 5 apps.

## 9. Economics

### Two estimates

| Point | Knows | Gates |
|---|---|---|
| after `triage` | idea shape only | the ~$5 front half — a rough band, so you can bail early |
| after `plan` | stack, criterion count, slice count | the expensive half — the number that matters |

Estimating build cost from an idea alone is close to guessing: a 12-criterion spec and a 43-criterion one differ by 3x and triage cannot know which it will be. Estimating only after `plan` means ~$5 is spent before any number appears. Hence both.

`ESTIMATE.md` is also where **model selection** belongs when it arrives — "these four slices are mechanical, run them on a cheaper model". Nothing in Phase 2 does this; the file is the natural home.

### Budget

A per-project ceiling, set by the user at capture or in preferences. `COST.jsonl` already sums spend. On hit, the project **parks as `needs you`** with spend-so-far and remaining work; the user raises the ceiling or takes the partial delivery.

This is a deliberate exception to the product's core rule. Everywhere else: *never block on something you could decide yourself*. Money is the case where the pipeline genuinely cannot decide — it is the user's money, and being wrong in either direction is bad. Same reasoning that makes cost-material decisions questions rather than defaults.

### Measured baseline (first real run)

| Stage | Cost | Time |
|---|---|---|
| triage | $0.33 | 21s |
| research | $1.81 successful ($3.07 incl. a failed attempt) | 678s |
| spec | $0.99 | 251s |
| clarify | $0.79 | 139s |

Front half: **~$3.93**. Cache reads outnumber writes ~10:1 on long stages, which is why a 24-turn stage costs ~$1.81 rather than 24x the ~$0.29 cold-context floor.

## 10. File formats — three move to structured data

Format follows the consumer. Prose files are read by models, which handle markdown natively. Structured files are read by code, which wants a schema.

| File | Format | Why |
|---|---|---|
| **Acceptance criteria** -> `CRITERIA.jsonl` | JSONL | `plan` slices them, `test-write` enumerates them, `review` audits them. **Three stages parse this.** |
| `DECISIONS` -> `DECISIONS.jsonl` | JSONL | Defined fields; powers the tap-to-change UI; filtered by `blast_radius` |
| `QUESTIONS` / `ANSWERS` -> JSON | JSON | Removes `parseQuestions`' three known silent-failure modes (skipped `- [x]`, dropped indented options, empty section on a leading question) |
| `SPEC.md`, `RESEARCH.md` | markdown | Prose, for humans and models |

`SPEC.md` keeps its prose and references criteria by id. JSONL specifically: append-only works natively, one record per line survives a partial write, and a malformed line fails loudly rather than being skipped. Rendering stays a command (`sfo criteria`, `sfo decisions`), the pattern `sfo cost` established.

**`decided_by` is required on every decision record.** A field written only in the interesting case makes absence load-bearing, and absence cannot be distinguished from a bug or a version skew.

## 11. Carried over from the first real run

These four modify **Phase 1 stages** (`research`, `clarify`) rather than adding new ones. They are Phase 2 work because the first real run is what surfaced them, and because the format changes in §10 touch the same prompts.

**Prior-art verdict gates the pipeline.** `research` emits a structured verdict alongside its prose:

| verdict | behavior |
|---|---|
| `no_gap` | **Stop before `spec`.** Park with "use X instead", the link, and why. |
| `marginal_gap` | Park and ask: here is what exists, here is the delta, still want it? |
| `clear_gap` | Proceed. |

The first run produced an excellent 30KB research document that nothing acted on; the "don't build" option surfaced only because the spec stage happened to make it a question option. A pipeline that can only say yes to ideas is an expensive way to generate work.

**Fast clarify loop.** When `clarify` generates new blocking questions, prompt immediately rather than parking. The founding constraint — never block, because every round trip costs hours — applies to the async boundary, not to a user already at the keyboard.

**Question granularity over nesting.** Prefer more options on one question; nest only when the follow-up opens an axis that exists solely because of the answer (choosing a local model only matters if local was chosen). Flattening a conditional axis produces combinatorial explosion.

**`git add -A` needs real ignores before the build stage writes code.** Safe today because stages emit only markdown. Once `build` runs, `node_modules/`, `.venv/`, build output and stray scratch files land in history. The per-project `.gitignore` is seeded per archetype.

## 12. Explicitly deferred

Test-change adjudicator (build on evidence of need) · `ambiguity_policy` blocking modes · second archetype · deploy-to-URL delivery · follow-up/brownfield requests · Expo client · cloud runner · sandboxing · accounts and BYO key · database · second runner implementation.

`ambiguity_policy` stays `autonomous`: decide, record with `blast_radius`, surface at delivery. Slicing already bounds the cost of a wrong call to one slice, and the tap-to-change review remains the centrepiece interaction.

## 13. Scope — this is two plans

The work splits cleanly along a dependency, and each half produces something testable on its own:

**Plan A — formats and gates.** `CRITERIA.jsonl` / `DECISIONS.jsonl` / JSON questions, the `sfo criteria` and `sfo decisions` renderers, the prior-art verdict, the fast clarify loop, per-archetype `.gitignore` seeding, and the rough `estimate`. Every later stage parses these, so getting them wrong is expensive; none of it spends build money.

**Plan B — the build half.** `plan` slicing, precise `estimate`, `test-write`, `test-repair`, sliced `build`/`verify`, `review`, `deliver`, the `cli` archetype and its verify recipes.

B depends on A: `plan` slices `CRITERIA.jsonl`, and re-running Phase 1 to regenerate a spec in the new format costs ~$4 each time. Doing A first means regenerating once.

## 14. Definition of done

- The screenshot renamer builds from its existing `SPEC.md` and passes its own generated test suite.
- A deliberately unbuildable slice produces an honest partial delivery whose summary leads with the gap.
- `sfo cost` attributes spend per slice.
- `review` finds at least one genuine coverage gap on a real spec, or is demonstrated to be redundant and cut.
- A killed build loses one slice, not the run.

## 15. Open questions

- How large should a slice be? Too small multiplies fixed per-invocation cost; too large recreates the untractable-starting-point problem. `plan` refining the spec's grouping gives a starting point, but the right size is empirical — the first build run is the evidence.
- Whether `review` earns its cost once tests are written blind — §13 makes this measurable rather than assumed.
- Whether 43 criteria is the right density, or whether the spec prompt needs a "criteria that would catch a real defect" nudge. Only answerable by running a build against them.
