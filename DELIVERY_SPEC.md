# Delivery and Aftercare — Spec

**Status:** Implemented, 2026-09-29
**Date:** 2026-09-29
**Depends on:** `SMOKE_SPEC.md`, `REVIEW_REPAIR_SPEC.md`, `CONTEST_SPEC.md`
**Prompted by:** the second real run, `ut-tower`

---

## 1. Why

`ut-tower` finished with 12 of 14 slices, a seam that "failed", and 22 review
findings. Everything wrong with how it ended is something the person saw and
sfo didn't handle:

- **You couldn't run it.** `ut-tower` wasn't on your PATH.
- **The failed seam was a broken test.** The smoke test read a pseudo-terminal
  after closing it, so it saw zero bytes. Review diagnosed this (R-011), but
  nothing could act on it: repair may not touch tests, and coverage findings
  are report-only.
- **The repairs made it worse.** Round 2 found that the R-005 repair broke the
  links in 188 of 261 real answers (R-016). Round 2 is report-only, and
  `sfo status` counted only "unrepaired" findings, so it never said so.
- **Nothing said what to do next,** because there was nothing to do: no path
  existed after delivery.
- **Nobody looked at it.** The Tower was drawn white on the person's white
  terminal. Every test passed, because no check looked at the rendered output.

## 2. Install on PATH (deliver)

Before the deliver agent writes `SUMMARY.md`, sfo installs the tool
mechanically and checks it:

| Archetype | Install | Command names from |
|---|---|---|
| `cli-python` | `uv tool install --editable <project>` | `[project.scripts]` in `pyproject.toml` |
| `cli-node` | `npm link` in the project | `bin` in `package.json` |

- **Check it from a fresh login shell** (`zsh -lc` / `$SHELL -lc`): each command
  resolves (`command -v`) and `<cmd> --help` exits 0 within 30 seconds. Going
  through a fresh shell is the point: sfo's own `sfo` command was broken in
  exactly the way only a real install shows.
- **Never clobber.** If a command name already resolves to something sfo
  didn't install, or the installer refuses, it's recorded as not installed,
  with the reason.
- The results go to `.sfo/INSTALL.json`. `SUMMARY.md` opens "How to run it"
  with the installed commands, or with why they weren't installed.

**API keys without an alias.** A generated tool that needs the Anthropic key
reads `ANTHROPIC_API_KEY`, and otherwise reads the macOS Keychain entry named
in `.sfo/ACCESS.json` (`keychainService`, the service name only, never the
key). The shell function shotname needed then becomes unnecessary for anything
built from here on.

## 3. How a tool presents itself (spec decides, per project)

`spec` writes `.sfo/PRESENTATION.json`:

```json
{"kind":"visual","why":"the answer is a coloured drawing of the Tower",
 "invocations":[["ut-tower","--now","2026-09-26T21:30:00-05:00"],["ut-tower","--now","2026-09-29T21:30:00-05:00"]]}
```

- **`kind`:**
  - `visual`: the look is the product, such as art, colour or layout.
  - `text`: plain output where the content matters and the look doesn't.
  - `none`: the output is a file or a side effect, with nothing to see.
- **`invocations`** are deterministic runs that show the tool doing its main
  job, with fixed inputs such as `--now` so the output doesn't drift.
- **At test-write:** for `visual` and `text`, add snapshot tests: golden files
  of each invocation's exact output, ANSI codes included, under
  `tests/snapshots/`, and locked.
- **At the end of smoke:** each invocation runs through the project's own
  environment on a real pseudo-terminal (`script`). The capture goes to
  `.sfo/renders/<n>.txt`. For `visual`, if a renderer (`freeze`) is installed,
  each capture is also rendered as a PNG on a **light and a dark** terminal
  background. If none is installed, the report says the screenshots were
  skipped and how to get them.
- **Review looks at the renders:** it reads the captures, and views the PNGs
  for `visual`. A finding that the output is unreadable on one background is
  a `code` finding like any other.
- **`SUMMARY.md`** includes the text captures, and links the PNGs.

## 4. Roll back a repair that introduced a regression

- Each repaired finding records the commit that repaired it (`repairCommit`).
- Round 2 attributes: a round-2 finding caused by a repair names the repaired
  finding in `causedBy`.
- For each **high** round-2 finding with a `causedBy`, the repair commit is
  **reverted** (`git revert`). The findings that commit repaired go back to
  `unrepaired` ("repair rolled back: it introduced R-016"), and the round-2
  finding becomes `rolled_back`. If the revert conflicts, it's aborted and
  reported; nothing is forced.
- After a revert, the passed-slice gate runs again. If it fails, that's
  reported too.

This trades a new, unreported regression for the original, known and reported
gap.

## 5. Wrong tests go to the adjudicator

- **Review can say a test is wrong.** A new finding kind, `test`, covers a
  test or test helper that is itself defective (R-009's helper, R-011's pty
  harness). It names `testFile`. In round 1, each `test` finding becomes a
  contest filed by sfo on the reviewer's behalf and is adjudicated (at most 3
  per review). An amended test is relocked, and every passed slice is
  re-verified, as for any amendment.
- **A seam that still fails after its repair round** has its smoke test sent
  to the adjudicator automatically, with the failure output and any review
  finding about it as evidence, if the `SMOKE` contest wasn't already used.
  If the test is amended, that seam is checked again, with no further repair.

## 6. Retry means "redo what failed"

`sfo retry <id>`, with no slice given, retries **everything that failed and
nothing that passed**:

| Failed | Retried as |
|---|---|
| slices | fresh attempts in the build (as today) |
| seams (latest result `failed`) | their smoke checks run again, with a repair round |
| high findings `unrepaired` | a repair round against their locked tests; round 2 re-reviews |

- The set is written to `.sfo/RETRY.json`, and the run starts at the earliest
  stage with work to do. Smoke runs only the retried seams, and review skips
  round 1 and repairs only the retried findings. Deliver writes a new
  summary. `RETRY.json` is cleared once deliver completes.
- **Anything that failed twice goes to the adjudicator** (§5) instead of being
  repeated with the same inputs, which fail the same way.
- `sfo retry <id> <slice>` keeps its current meaning.

## 7. Every status says what to do next

Every `sfo status` note and notification ends with a command:
- `done, but …` points to `sfo retry <id>` when there's anything to retry
- `failed at …` points to the recovery hint for that stage
- parks point to `sfo answer`, `sfo budget`, or `sfo run`

**Round-2 high findings count** in the `done, but …` note, including ones
resolved by a rollback.

## 8. Order

1. Install on PATH, plus the Keychain key prompt.
2. Next steps in status and notifications, and round-2 findings counting.
3. Rollback of a repair that caused a regression.
4. Wrong tests to the adjudicator.
5. Retry what failed.
6. Presentation: `PRESENTATION.json`, snapshot tests, captures, PNGs, review
   and SUMMARY.

## 9. As built

- **Screenshots use sfo's own renderer, not `freeze`.** A small Pillow script,
  run with `uv run --no-project --with pillow`, so nothing gets installed
  system-wide. Drawing it ourselves means "default foreground" is dark on the
  light background and light on the dark one, which is exactly the
  distinction that hid the white Tower. Verified on ut-tower: after the fix,
  tonight's white Tower is visible on light, and the orange top shows on
  dark. The dark render of the 26th also shows R-016's mid-path URL wrap at a
  glance.
- **Captures run through `script -q /dev/null …` with stdin closed.** `script`
  rejects a pipe for its own input, and echoes a literal `^D` and two
  backspaces first, which are stripped.
- **Installed commands are checked positionally.** A command name reaches the
  shell only as `$1`, and a name that isn't a plain command name is refused.
  That came from a security review of the first version, which spliced names
  into a double-quoted shell script.
- **Rollback reverses only code outside `.sfo/`,** applied as one reverse
  patch, all or nothing. A `git revert` of a `commitStage` commit would also
  roll back sfo's own state and findings, and refuses to run while they're
  being written.
- **Retry scope:** a retry that rebuilds slices re-checks every seam and
  reviews in full, because the code changed. Otherwise smoke checks only the
  failed seams, and review runs only a repair round for the retried
  findings, or doesn't run at all if there are none.
