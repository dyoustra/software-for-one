# Parallel Slices — Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-09-27
**Depends on:** `CONTEST_SPEC.md` (built first), `docs/RUNBOOK.md` B11
**Order:** Build after the contest channel. That spec changes the slice loop this one generalizes.

---

## 1. Why

B11 ran 11 slices one after another. Its prerequisite graph has 5 waves:

```
wave 1  S-01  S-02
wave 2  S-03  S-04
wave 3  S-05
wave 4  S-06  S-07  S-08  S-09  S-11
wave 5  S-10
```

The critical path is 5 slices long. At about 3 minutes per slice, the build
takes about 15 minutes instead of about 33. Plans with a wider graph gain more.
Cost stays about the same, apart from reruns caused by conflicts (§5).

## 2. Model

- Each slice in flight gets its **own git worktree** on its own branch. Slices
  can't see each other's half-written files, and a failed attempt's code stays
  in that slice's worktree for its retry. That is the "code from that attempt
  is still in the tree" behaviour `buildPromptFor` promises. Today the
  sequential loop leaves a failed slice's uncommitted code in the *shared*
  tree, where the next slice builds on top of it. Worktrees fix that as a side
  effect.
- A slice that passes in its worktree is **merged into the project's branch
  one at a time** by the orchestrator. It then passes the slice gate again on
  the merged tree before the merge is committed.
- One process and one event loop. Concurrency is at the level of the `claude`
  subprocesses and the gate subprocesses. No threads, and no locks between
  processes.

## 3. Concurrency setting

- The default is **3**. It is adjustable per run with
  `sfo run <id> --concurrency N`, or globally with `SFO_CONCURRENCY=N`. The
  flag wins.
- `N = 1` is the sequential loop, and it runs through the same code path. It
  still uses a worktree and a merge, so there is one loop to test rather than
  two.
- The value is not stored on the project. It's a property of the machine and
  of how much you're willing to spend at once, not of the project.

## 4. Worktrees

- **Location:** `<projectsRoot>/.worktrees/<id>/<sliceId>`. That's outside the
  project repo, so nothing inside it is ever staged by the project's own
  commits. `listProjects` already skips directories that have no
  `state.json`.
- **Branch:** `sfo/<sliceId>`, created from the project's `HEAD` at dispatch.
- **Setup:** the gate's first step is `uv sync` or `npm ci`, and it installs
  into the worktree. uv's global cache keeps that to seconds. `node_modules` is
  installed separately in each worktree. It's never shared, because a slice
  that adds a dependency would change it under everyone else.
- **`.sfo/` in a worktree is read-only by convention.** The agent reads
  `SPEC.md` and `CRITERIA.jsonl` from its checkout. When merging, any change
  the slice made under `.sfo/` is discarded, except `CONTEST.json`, which the
  orchestrator collects first. State, costs, verify records and contests are
  written only to the main project's `.sfo/`.
- **Lifetime:** a worktree is removed when its slice merges. It's kept while
  the slice is retrying or has failed, so `sfo retry` resumes in it and a
  human can inspect it. It's removed when the project is delivered.
- **Crash recovery:** on `sfo run`, a worktree for a slice that has neither
  passed nor failed is resumed as-is. The agent runs again with its code still
  in place, and the interrupted attempt isn't counted, because it never got a
  verdict. A worktree for a slice that has passed or failed, or that isn't in
  `SLICES.jsonl`, is removed.

### 4.1 Paths are no longer always `projectDir(id)`

`verify.ts` and `testlock.ts` resolve everything from `projectDir(id, env)`.
They have to take the directory to act on:

- `runVerify(id, archetype, slice, env, dir)` and `sliceTestFiles(…, dir)`
- `verifyTestLock(id, env, dir)` checks the worktree's tests against the lock
  in the **main** project's `.sfo/`. The lock is always read from the main
  project, because a worktree's copy could be stale or tampered with.
- `commitStage(id, stage, env, dir)` commits in the worktree, on its branch.

`dir` defaults to `projectDir(id, env)`, so existing callers don't change.

### 4.2 The gate must not block the event loop

`runRecipe` uses `spawnSync`. A gate that runs for a minute would freeze every
other slice's stream reading, and could fill their pipe buffers and stall
their `claude` processes. The heartbeat would stop too. `runRecipe` becomes
async, using `spawn` wrapped in a promise, and every caller awaits it. This is
the largest mechanical change in the spec. Do it first, as its own commit,
with the loop still sequential.

## 5. Merging

Merges are serialized: one slice merges at a time, in the order the slices
finish.

1. `git merge --no-commit --no-ff sfo/<sliceId>` into the project branch.
2. **Clean merge:** run the slice's gate on the merged tree. Also run
   `verifyTestLock` there. A relock by the adjudicator might have happened
   since this slice started (`CONTEST_SPEC.md` §7).
   - It passes: commit as `build(<sliceId>): …`, add the slice to
     `slicesPassed`, and remove the worktree.
   - It fails: `git merge --abort`, and the slice gets a conflict rerun (§5.2).
3. **Conflicted merge:** try to resolve the lockfile (§5.1). If that isn't
   possible, `git merge --abort` and the slice gets a conflict rerun.

A slice that passed in its worktree but fails on the merged tree didn't fail
on its own. It collided with work that merged before it, so it's treated like
a textual conflict.

### 5.1 Resolving lockfile conflicts automatically

Two slices that each add a dependency will always conflict on
`uv.lock`/`package-lock.json`, and usually on the manifest's dependency list
too. Resolve this only when **every** conflicted path is in the archetype's
set of manifest files:

| Archetype | Manifest | Lockfile | Re-add |
|---|---|---|---|
| cli-python | `pyproject.toml` | `uv.lock` | `uv add <deps>`, `uv add --dev <deps>` |
| cli-node | `package.json` | `package-lock.json` | `npm install <deps>`, `npm install -D <deps>` |

Procedure:

1. From the merge base and the slice's branch, compute the dependencies the
   slice **added**: new names in `[project].dependencies` and
   `[dependency-groups].dev`, or in `dependencies`/`devDependencies`. Parse
   the files; don't diff them as text.
2. Check that the slice's manifest changes are *only* dependency additions.
   If anything else in the manifest changed (scripts, tool config, version
   pins on existing packages), it's a real conflict.
3. Take the project branch's manifest and lockfile (`git checkout --ours`),
   re-add the slice's dependencies with the tool, and let the tool regenerate
   the lockfile.
4. Continue with step 2 of §5 (gate on the merged tree).

This belongs to the archetype. Put it in `archetype.ts` next to the recipe, so
a new archetype declares its own manifest files or gets no automatic
resolution.

### 5.2 Conflict reruns

- The slice's branch and worktree are thrown away. A fresh worktree is created
  from the current project `HEAD`, which now includes whatever it collided
  with, and the slice runs from scratch.
- The prompt says so: "An earlier attempt at this slice passed but collided
  with <merged slices> on merge. Their work is now in the tree."
- **The rerun doesn't count toward `MAX_SLICE_ATTEMPTS`.** Conflict reruns
  have their own cap: `MAX_CONFLICT_RERUNS = 2`, tracked in a new
  `sliceConflicts` record on the state, defaulting to `{}` like
  `sliceAttempts`.
- **Once the cap is used up, the slice runs solo.** It waits until nothing
  else is in flight, runs, and merges with nothing to collide with. A slice
  that has been made to run solo never gets a conflict rerun.

## 6. Scheduling

At each scheduling point (start of the run, and after any slice finishes or
merges):

1. The runnable set is the slices whose prerequisites have all *merged*.
   Passing in a worktree isn't enough, because a dependent slice has to build
   on its prerequisite's code. It excludes slices already in flight, passed,
   failed, or skipped by a failure.
2. If a slice is waiting to run solo, start nothing new until the in-flight
   count reaches 0. Then start only that slice.
3. Otherwise, fill free slots in `SLICES.jsonl` order, subject to the budget
   (§7).
4. If nothing is in flight and nothing can run, the build is finished. That's
   the same end condition as today's `nextRunnable() === null`.

`nextRunnable` becomes `runnableSlices(slices, progress): Slice[]`, and the
cycle check stays in `validate`.

## 7. Budget: reserve before dispatch

The ceiling is checked before any money is spent, and that now includes money
already committed to slices in flight.

- **Reservation per slice:** the plan's build-phase `highUsd` divided by the
  number of slices, until 2 slices in this project have finished. After that,
  it's 1.5× the mean actual cost of this project's finished slice runs, taken
  from `COST.jsonl`.
- Dispatch a slice only if `spent + sum(reservations in flight) + reservation`
  is at most the ceiling. If it doesn't fit and nothing is in flight, park
  `{ park: "budget", stage: "build-<slice>", budget }` exactly as today. If
  something is in flight, wait for it to finish, because its reservation might
  free up enough room.
- When a slice finishes, its reservation is released and its real cost is
  recorded.
- With no ceiling set, there are no reservations and nothing to check.
- **The adjudicator counts as a slot, with its own reservation.** It uses the
  same formula, applied to adjudicate runs, with a $3 floor until one has run.

## 8. State and the heartbeat

- All updates to `state.json` happen in the orchestrator process. They must be
  a synchronous read–modify–write with no `await` in between. That's the
  invariant that makes one process with concurrent subprocesses safe without
  locks. Write it as a helper, `updateState(id, env, fn)`, so it isn't left
  to the discipline of each call site.
- One heartbeat for the whole run, not one per slice. It stays up as long as
  anything is in flight.
- `state.inFlight: string[]` (defaults to `[]`) is shown by `sfo status` and
  `sfo slices`, so "building S-06, S-07, S-09" can be seen. On a crash, the
  list is ignored and rebuilt from the worktrees (§4, crash recovery).

## 9. Visibility

- `sfo slices <id>` gains a `building` state, the worktree path, and the
  conflict-rerun count.
- Each slice keeps its own log, `logs/build-S-06.log`, as today. Merge
  outcomes go into `logs/build-merge.log`, and conflicts and lockfile
  resolutions are also recorded in `VERIFY.jsonl` with `trigger: "merge"`.
- `SUMMARY.md` reports the concurrency used, the wall-clock time for the
  build, and any conflict reruns with their cost.

## 10. Build order

1. Make `runRecipe` async and thread `dir` through verify, testlock and
   commitStage, with the loop still sequential. There's no behaviour change.
   All existing tests should pass.
2. Add worktree lifecycle and merge-with-gate at `N = 1`. It's still
   sequential, but now uses worktrees.
3. Add the scheduler, `runnableSlices`, `inFlight` and `--concurrency`.
4. Add conflict reruns with the solo fallback.
5. Add lockfile auto-resolution.
6. Add budget reservations.
7. Rerun a B11-sized project at `N = 3` and add it to the runbook.

## 11. Out of scope

- **Regressions across slices.** The merge gate runs *this* slice's tests,
  the same as today's sequential gate. A slice can break an earlier slice's
  tests without anyone noticing until review. That's a real gap, and
  parallelism makes it more likely. The fix, a full-suite check before
  deliver, should be designed on its own.
- **Choosing concurrency from machine resources.**
- **Distributing slices across machines.**

## 12. Tests to write

- `runnableSlices` returns every slice whose prerequisites are all merged.
  Merged prerequisites unlock a slice; prerequisites that are only in flight
  or have passed don't.
- With `N = 3` and 5 runnable slices, 3 start. When one finishes, the next
  starts, in plan order.
- Each worktree is created on its own branch from the current `HEAD`, removed
  after merging, and kept after a failure.
- A clean merge whose gate fails is aborted and rerun, and `sliceAttempts` is
  unchanged.
- A textual conflict is aborted and rerun. After 2 reruns the slice waits,
  runs solo, and merges.
- A lockfile-only conflict is resolved: both slices' dependencies are in the
  merged manifest.
- A manifest conflict that changes more than dependencies is not auto-resolved.
- A relock between dispatch and merge makes `verifyTestLock` run on the merged
  tree.
- The reservation blocks dispatch when in-flight reservations plus the next
  slice's would pass the ceiling, and releases when a slice finishes.
- The gate runs asynchronously: a stub runner's stream keeps being read while
  a slow gate runs.
- `updateState` has no `await` between read and write (test the helper's
  contract with a runner that writes concurrently).
- Crash recovery resumes a worktree with no verdict without counting an
  attempt, and removes worktrees for slices that have finished.
- `N = 1` produces the same slice results as the old loop on the existing
  orchestrator fixtures.
