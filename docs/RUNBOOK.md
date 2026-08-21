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
