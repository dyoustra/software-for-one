# Phase 1 runbook — first end-to-end run

**Date:** 2026-08-21
**Idea:** "cli that renames my screenshot files based on what's in them. i have like 4000 of these named `Screenshot 2026-01-14 at 3.42.11 PM.png`" (verbatim from `TEST_IDEAS.md`)
**Result:** completed `capture → triage → research → spec → clarify` and reached `done`.

## Measured cost

| Stage | Runs | Cost $ | Out tok | Cache write | Cache read | Time |
|---|---|---|---|---|---|---|
| triage | 1 | 0.3328 | 1,176 | 30,342 | 0 | 20.5s |
| research | 2 | 3.0651 | 22,325 | 103,126 | 1,313,091 | 678.4s |
| spec | 1 | 0.9887 | 17,253 | 40,987 | 294,880 | 250.6s |
| clarify | 1 | 0.7904 | 9,339 | 34,277 | 428,193 | 138.8s |
| **TOTAL** | **5** | **5.1771** | **50,093** | **208,732** | **2,036,164** | **1088.3s** |

- **Successful-path cost: $3.93.** The $1.25 difference is a research attempt lost to a VPN reset.
- **Research is 78% of the successful-path cost** and 62% of wall-clock. It is the stage to optimise first.
- **Cache reads outnumber writes ~10:1** (2.04M vs 209K). Long multi-turn stages are dominated by cache reads, which is why a 24-turn stage costs ~$1.81 rather than 24 x the ~$0.29 cold-context floor.
- Triage cold (no cache) cost $0.33 and took **23.9s** end to end via the CLI path.

## Output quality

- **43 acceptance criteria**, genuinely machine-checkable. Several specify their own assertion mechanism ("asserted by comparing the set of inodes before and after `--apply`"; "test: stub the model to return `3:42 PM / dashboard`"). This is the finding Phase 2's verification gate depends on, and it came out positive.
- **9 questions** (4 blocking, 5 preference) — inside the 5–10 target band with no tuning.
- The research stage surfaced a real gotcha that propagated into acceptance criterion #1: the space in `3.42.11 PM` is **U+202F narrow no-break space** on recent macOS, which breaks naive globbing.
- The first blocking question offered **not building the project** ("Spotlight works well enough; don't build this — kills the project, costs nothing"), tracing from one line in the research prompt through two stages.
- Clarify correctly applied a human override against its own default, recorded `decided_by: human (ANSWERS.md)` on 9 entries, and **derived two new requirements** from the override rather than merely recording it.

## Defects found and fixed during the run

1. **Stages wrote artifacts only at the end.** A 336s / $1.25 / 24-turn research stage died on `API Error: Connection closed mid-response` (VPN reset) and left **zero artifacts**. Fixed by requiring incremental writes in the prompts; the retry left partial findings on disk throughout. Retry alone would not have fixed this — it re-buys the same fragility per attempt.
2. **Triage needed a different credential from every other stage.** It used the Anthropic SDK (needs `ANTHROPIC_API_KEY`) while every stage used the `claude` CLI's own credential, so `sfo new` failed outright on a machine with a working CLI. Now SDK-primary with a loud CLI fallback.

## Open issues, not fixed

1. **`sfo stage` never writes `running` state.** During a re-run, `sfo status` shows the stale prior status — it reported `failed` while a retry was actively working. Same honesty problem as the detached-run bug, different command.
2. **43 acceptance criteria may be over-specified.** In Phase 2 that is 43 tests the build stage must satisfy. Watch whether builds become slow or brittle; the spec prompt may need a "criteria that would catch a real defect" nudge.
3. **The fallback warning understates latency** — it says ~10s, measured 23.9s.
4. **SDK-path pricing is hardcoded** (`$5`/`$25` per MTok) and will silently drift when Anthropic reprices. The CLI path reports its own `total_cost_usd` and is immune.

## Extrapolation

At ~$3.93 per idea on the successful path, the spec's 10-idea validation lands near **$40**, assuming later ideas benefit from a warm cache within the hour. Research dominates; capping its turn count or scoping its brief is the highest-leverage cost lever.

---

# Plan A — artifact format migration

**Date:** 2026-08-21. Re-ran `spec` on the screenshot renamer against the new
schemas. **Cost: ~$2.16 / 680s** for that stage; project total now $7.34.

## The question this answered

*Will a model reliably emit schema-valid JSONL and JSON?* **Yes — first attempt,
no schema violations.** `sfo criteria` and `sfo decisions` both render. Every
downstream stage in Plan B parses these formats, so this was the load-bearing
assumption and it held.

## What changed, and what it does not prove

| | markdown | structured |
|---|---|---|
| Acceptance criteria | 43 | **64** (+49%) |
| Groups | 9 | 10 |
| Questions | 9 | 8 |
| Stage cost | $0.99 | ~$2.16 |
| Stage time | 251s | 680s |

**The comparison is confounded and should not be read as a format cost.** This
run had strictly more input than the first: a `SPEC.md` already clarified with
nine human answers, plus the previous round's decisions. More context reasonably
produces more criteria and costs more. Attributing the increase to JSONL would
require a same-input A/B, which has not been run.

## Findings

**`decided_by` works as designed.** 9 records attributed to `human`, 36 to
`agent`. The stage correctly carried forward the human decisions from the
earlier clarify round rather than reclaiming them — the exact distinction the
field was added for. Note the implication: a stage that never spoke to a human
can legitimately emit `decided_by: human` when preserving history.

**The new questions are a layer deeper, not a restatement.** The first round
asked about rename-in-place, naming convention, and cloud-vs-local. This round
asks about the Batch API vs bounded concurrency, which Apple OCR path, and
whether `--apply` may run without a saved plan. With the earlier answers folded
into the spec, the stage moved on rather than re-litigating. **Consequence: the
old `ANSWERS.md` had nothing to migrate** — no question survived to map onto, so
the planned hand-conversion was moot and was skipped.

**64 criteria is tractable because of slicing, not despite it.** Spread over 10
groups that is ~6 per slice, which is a reasonable build target. The spec's open
question about over-specification is better framed as "how large is a slice"
than "how many criteria are too many".

## Still open

- **Slice size** remains unanswered and is now the sharpest open question for
  Plan B: 10 groups ranging 2–9 criteria each is the natural default, but the
  2-criterion group may not justify a build invocation's fixed cost.
- The rough estimate anchors on a single calibration point ($3–6) and will
  read precise while being weakly informative until more real runs accumulate.

---

# First end-to-end build: `shotname` (Phase 2, B11, 2026-09-26)

**Outcome: all 11 slices passed, all 80 criteria met, 187 tests green. $99.79 total.**
The built CLI runs, and its missing-key preflight refuses cleanly without touching
files. Naming itself was not exercised (no API key in the build shell).

## Cost by phase

| Phase | Cost | Notes |
|---|---|---|
| research → clarify (Phase 1, incl. reruns) | $9.39 | |
| plan | $1.13 | estimated the build at $17–$48 |
| test-write | $11.73 | 77 turns, 32 min. Not in the estimate at all |
| test-repair | $9.19 | ran blind (see below) |
| build, 11 slices | $56.56 | incl. ~$34 lost to sfo defects |
| review + deliver (twice) | $11.81 | first pass reported on a half-built project |

**Per slice, once agents could run their toolchain: about $1.85 and 3 minutes**
(S-05 to S-11, S-01's final attempt). Blind, the same slices ran $2.50–$6.30 and
up to 34 minutes. A clean run with the fixes below would be roughly $22 for the
build plus ~$7 for review and deliver, inside the plan's estimate. The estimate's
real miss was test-write, which it did not cover.

## Defects the run found, all fixed

| Defect | Cost on this run | Fix |
|---|---|---|
| Stages ran with `acceptEdits` only: every `uv`, `pytest`, `ruff`, `mypy` denied | test-repair and S-01–S-03 built blind | `--allowedTools` per stage, derived from the recipe (`d209cfe`) |
| Headless runs inherited the user's own allowlist (`python3`, `xargs`, `gh api`) | none observed | `--setting-sources project,local` (`d209cfe`) |
| test-repair locked 4 lint/type errors into test files; no slice could pass lint | 1 slice attempt, run stopped | install/lint/typecheck checked before `lockTests` (`7614ee3`) |
| Build prompt said the gate ignored tidiness; `ruff check` is in it | S-01 attempt 1 | prompt lists the exact gate commands (`7614ee3`) |
| Retries got the same prompt as the failed attempt | every retry | retry sees the tail of the last verify log (`7614ee3`) |
| `verify.ts` passed `tests/__pycache__/*.pyc` to pytest (exit 4) | 1 S-01 attempt | shared filtered walk (`137b8a3`) |
| Root `conftest.py` outside the lock could alter collection | an agent wrote two | lock hashes every `conftest.py` (`145f6df`); caught S-04's on attempt 1 |
| Estimate omitted test-write/test-repair and was checked after them | $11.73 unseen by the gate | estimate covers everything after plan, checked before test-write (`67a1fe7`) |
| `advance` ignored projects Phase 1 marked `done` at clarify | project could not continue | `6a6e498` |
| `sfo retry` left a delivered project `done` | `sfo run` would no-op | reopens the build (`1d4ba2e`) |

## Tests that were wrong, adjudicated by hand

Both recorded in the project's `DECISIONS.jsonl`.

- **AC-009 peak memory.** Measured with `tracemalloc` from a 3.6 KB baseline. CPython
  `pathlib` interns every path segment, triggered by the locked fixture itself, so
  peak grew 530x regardless of the code. Real peak RSS: 27.7 MB at 500 files, 28.9 MB
  at 50,000 (1.05x, limit 2x). Rewritten to measure RSS in subprocesses. This one test
  failed S-01 twice and skipped 8 of 11 slices.
- **Four lint/type errors** in test files (import order, a deliberate local-time call,
  a `typer` vs `click` annotation). No assertion changed.

## Open

- **No way to contest a test.** Twice a build agent hit a defect in the locked suite.
  With AC-009 it failed twice. With `monkeypatch.undo()` also reverting the fixture's
  environment (S-04), it first wrote a `conftest.py` (blocked), then **changed
  production code** to cache credentials per directory so the flawed test would pass.
  Both needed an adjudicator; neither had one to ask.
- **Slices run sequentially** though the plan has independent ones (five after S-05).
- **The real-world seams never executed:** Vision OCR, the Anthropic and Ollama
  transports, the Spotlight probe. `SUMMARY.md` leads with this.
- `review` found real coverage gaps (e.g. `--resolution` never tied to the bytes sent).
  Nothing acts on them.

---

# Run 2: `ut-tower`, the second real idea (2026-09-27 to 09-30)

"Why is the UT Tower orange tonight?", as a CLI. It was the first run with
contests, model access, smoke, review→repair, install, presentation, retry and
feedback in place, and each of them met a real case. Total: **$247.49**
API-equivalent on the Max plan, **$0.00 billed**, across one build, two
retries and two feedback runs.

## Outcome

- **14 of 14 slices pass.** That took two retries. S-13 was blocked first by
  the lock, then by a broken test helper.
- **Every seam passes live** against tower.utexas.edu, the IANA timezone
  data, the local cache, the system clock and a real pseudo-terminal.
- **Review found and repaired real bugs:** the next fixture's date recorded
  as a lighting night, and real announcements dropped. One high finding
  (R-009) is left for feedback.
- **Installed as `ut-tower`,** with light and dark screenshots.
- **Feedback 2 redrew the Tower** ($3.72, one session). The person's verdict
  is that it still doesn't look like the Tower, because ASCII is the wrong
  medium (see below).

## What each new mechanism did, for real

| Mechanism | What happened |
|---|---|
| Contest | The S-09 fixture announced the wrong night, and was amended. S-13 raised a criterion defect, and **the person answered mid-build**, and AC-102 was rewritten. |
| Adjudicator, filed by sfo | The RSS smoke test asserted conditional GET, which UT's server doesn't implement, and was amended. The colour smoke test read its pty after closing it, and was amended. S-13's `build_artifacts` helper globbed uv's `dist/.gitignore`, and was amended on retry. |
| Smoke | Found 4 real bugs against the live site that the fakes had hidden, including a 404 past the archive's end. Three were fixed by the repair loop. |
| Review → repair | Round 1 found R-001 and R-002, both reproduced and repaired. Round 2 caught regressions a repair had introduced (URLs wrapped mid-path). |
| Sandbox | Chained commands run, writes outside the project are refused by the OS, and uv works once mach lookups are allowed. |
| Feedback | The first run failed on sfo's gate bug. The second passed first time. |

## Defects the run found in sfo, all fixed

| Defect | Effect | Fix |
|---|---|---|
| `recommendation: null` failed the prior-art schema | the run died after research, and state stayed `running` | nullish, plus `CRASH.json` (`d2f4a08`) |
| Resume went to the stage *after* an interrupted one | a crash mid-stage would skip that stage | `completedStage` (`d2f4a08`) |
| Allowlist refused chained commands and let `uv run python -c` through | 12 wasted turns in research alone | Bash sandbox (`f35bff1`) |
| uv panics under the sandbox | every build step would have failed | `allowMachLookup` (`f35bff1`) |
| A slice was given work under the locked `tests/` | S-13 captured 262 fixtures, which read as tampering | plan and test-write rules; drift discarded before the build commit (`b716f9f`) |
| Failures recorded no reason | "failed", with nothing to act on | `FAILURE.json`, and a next step in status (`b716f9f`, `370cbb1`) |
| Review round numbered 3 failed to parse; the fallback emptied the file | ten findings lost, two of them high | per-line reading, and archiving before a full review (`1b5b527`) |
| One smoke contest per project | the colour seam never got a ruling | per seam (`1b5b527`) |
| Retried slice failed identically, with no second opinion | S-13 failed three runs in a row | adjudicator on retry (`1b5b527`) |
| Latest smoke result picked by attempt number | status said a passing seam had failed | by time (`19ba099`) |
| Feedback gate rejected the feedback's own new test | first feedback discarded, $6.87 | extra tests excused (`2ed8f74`) |
| `sfo` itself: no shebang, and entry check by name | ran as a shell script and recursed, then did nothing | `effe1f1` |
| Installer spliced manifest names into shell text | command injection via `package.json` bin | positional args (`9b0df65`) |

## Lessons

- **Every "tested" mechanism broke on first real contact** through a fake
  that was kinder than reality: a fake transport, a fixture's dummy key, a
  fake gate, an untried install path. The rule now: a mechanism isn't done
  until it has had one real run.
- **The look of a visual tool has to be judged before the build.** Spec chose
  ASCII outlines for a building people know by sight. Drafts at clarify, now
  comparing media such as half-block pixel art, inline images and ASCII,
  would have put that choice in front of the person at the start.

# Run 3: `lattice`, the first web app (2026-10-02 to 10-03)

A pitch-quantization visualizer (Vite, React, TypeScript, Web Audio), and the
first real test of project-declared contracts: its own gate, Playwright in the
gate, renders as screenshots. Total: **$166.60** API-equivalent on the Max
plan, **$0.00 billed**. **No slice was ever graded.**

## What happened

1. test-repair's agent exited 1. sfo said to re-run it with `sfo stage`.
2. `sfo stage test-repair` succeeded, but skipped what follows test-repair in
   a run: the suite check, the red check and **the lock**. `sfo run` went on
   to the build.
3. The gate refused S-01 twice, "the test suite was never locked" ($30 of
   build). S-02 to S-13 all depend on S-01 and never ran.
4. The run carried on into smoke, review, review-repair and delivery ($46) on
   code nothing had graded. Review's reproduction tests created the lock,
   twenty minutes after the last gate.
5. SUMMARY.md said all of this honestly, in 41 KB.

What the reviewer measured by hand: typecheck clean; 17 of 290 node and 16 of
84 browser tests failing; three seams failing against the real libraries (the
pitch shifter lands 17 cents off at +12 semitones; `pitchy` does not throw on
a wrong-length window; an AudioContext starts without a gesture). The app runs
(`lattice`) and is slow.

## Defects the run found in sfo, all fixed

| Defect | Effect | Fix |
|---|---|---|
| `sfo stage test-repair` skipped the suite check, red check and lock | a whole build graded against nothing | `sealSuite` follows test-repair wherever it runs (`cf31b6a`) |
| A build on an unlocked suite failed each slice and carried on | $46 of smoke and review on ungraded code | no lock blocks the build before any slice (`cf31b6a`) |
| Nothing made speed a requirement | a working app that is slow | speed criteria with numbers; timing tests at 3× the target (`8e08f59`) |

## Lessons

- **The recovery path is a pipeline path.** The fix sfo itself recommended
  was the one route around the lock. Every "re-run with `sfo stage`" hint has
  to do what the run loop does after that stage.
- **A blocked gate should stop the run.** Carrying on to review only made a
  longer report about code nobody had checked.
- **The summary is too long.** 41 KB is not read. Not yet fixed.

# Run 4: `soundscape`, the first cloud run (2026-10-03)

A background command that adjusts a procedural drone to the app in front, built
entirely on a Fly Sprite (Linux) from the CLI, with the laptop free. Total:
**$37.79** API-equivalent on the Max plan, **$0.00 billed**.

## Outcome

- **10 of 10 slices passed on the first attempt.** No contest and no retry.
- **Smoke:** the local control endpoint passed against the real thing over
  loopback. Three seams that need a Mac (front-app notifications, PortAudio
  output, Core Audio's default device) were deferred, then **all passed on
  the Mac with `sfo check --ready`**, and `soundscape` installed from a new
  terminal.
- **Review:** one high finding left (R-001: the device-audio thread never
  finishes after the stop fade, so stop waits out a 1.6 s timeout and leaves
  the stream open). It needs a real audio device, which the Sprite does not
  have; two repair attempts failed there.
- **The person's verdict on the sound:** "like perfect", with the glassy
  palette a little much at high intensity.
- Spec knew where it was: it asked Python vs Swift because "the build pipeline
  runs on Linux with no Swift toolchain".

## What the Sprite needed

| Finding | Fix |
|---|---|
| No `bwrap`, so Claude Code's sandbox cannot start | `SFO_CONFINEMENT=vm`: bypassPermissions, the VM is the boundary (`6bb02f3`) |
| A detached job froze about 15 s after its exec session closed (3 of 120 ticks, 1 of 20 outgoing calls) | every heartbeat renews a five-minute Sprite task (`3826896`) |
| The bundled Claude Code (2.1.251) cannot update itself | re-point `~/.local/bin/claude` at the native install |
| `sfo answer` lost piped answers (readline drops early lines) | `sfo answer --from` (`03665b2`) |
| `sfo check` could not confirm hardware without a terminal | `sfo check --ready` (`c508eb6`) |
| 32 MB through `sprite exec` stdout overflowed its buffer | `sprite file pull` for anything large |
| The final state was never committed, so the clone read "stale" | commit on done and on every park (`1135831`) |

## Lessons

- **The cloud found what the Mac never would:** an always-awake machine and a
  terminal had hidden both the pausing and the missing non-interactive paths.
  The app needs those paths anyway.
- **Deferred checks work.** Everything that could be checked on Linux was;
  what needed the Mac waited, named exactly what it needed, and passed there.
