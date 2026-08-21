# Software For One — Design Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-08-21

---

## 1. Premise

Ideas for side projects are cheap and constant. The bottleneck is not ideas and not code — it is the **activation energy of sitting down**: opening a terminal, holding an hour-long planning conversation, and shepherding the build.

Software For One removes that. You dump an idea (typed or dictated) and close the app. Some hours later you get a notification: it is built and verified, or it needs a decision from you.

The name is the thesis. AI makes **bespoke software with an audience of one person** economically viable for the first time.

## 2. What v1 is

**v1 is a local CLI that runs the pipeline. There is no app.**

The entire product rests on one empirical question that no amount of design can answer: *do unattended agent builds pass an adversarial review often enough to be trusted?* If the answer is no, no client, notification system, or cloud runner saves it.

So v1 exists to produce one number.

### Success criteria

Run the pipeline against **10 real ideas** from the author's existing notes. Measure the share that clear the verification gate and adversarial review **with zero human repair**.

| Result | Interpretation |
|---|---|
| under ~30% | Thesis is wrong as stated. Stop and rethink. |
| ~30–60% | Right shape, tuning problem. Iterate on prompts and rules. |
| over ~60% | Build the app. |

Everything beyond the pipeline is packaging around that number.

**v1 delivery contract:** a git repository containing the working project, its `.sfo/` reasoning history, and a `SUMMARY.md` covering what was built, which decisions were made, and how to run it. Deploy-to-URL is a second delivery adapter, added once the pipeline is proven.

---

## 3. Core concepts

**Project** — one idea and everything produced from it. Lives in its own git repository.

**Stage** — one step of the pipeline. Runs as a fresh agent, reads artifacts, writes artifacts. Independently re-runnable.

**Artifact** — a markdown file in `.sfo/` that carries state between stages. Artifacts are the source of truth. There is no session to resurrect.

**Archetype** — a set of **slots** with defaults. Not a monolithic stack.

**Slot** — one configurable axis (framework, database, e2e runner…). Each slot *option* carries its own scaffold fragment and verify recipe.

**Decision** — a choice the agent made that you did not explicitly specify. Recorded with its blast radius.

---

## 4. The pipeline

| # | Stage | Reads | Writes | Human? |
|---|---|---|---|---|
| 0 | `triage` | raw capture | classification, dedupe check | notify only |
| 1 | `capture` | your dump | `IDEA.md` | — |
| 2 | `research` | IDEA | `RESEARCH.md` | — |
| 3 | `spec` | IDEA, RESEARCH | `SPEC.md`, `QUESTIONS.md`, archetype + slots | — |
| 4 | `clarify` | QUESTIONS + answers | updated `SPEC.md`, `DECISIONS.md` | **yes** |
| 5 | `plan` | SPEC | `PLAN.md` | — |
| 6 | `build` | SPEC, PLAN, DECISIONS | code, `DECISIONS.md`, `TEST_CHANGES.md` | only if policy says so |
| 7 | `verify` | repo | `VERIFY.md` | — |
| 8 | `review` | SPEC vs repo | `REVIEW.md` | — |
| 9 | `deliver` | everything | `SUMMARY.md`, committed git repo, notification | — |

**Repair loop:** stages 7 and 8 loop back to 6 on failure, **bounded at 2 attempts**. After that the pipeline stops and escalates with the specific failures. The bound is not arbitrary — unbounded self-repair is where agents begin weakening tests and stubbing functions to turn the gate green.

**Every stage is a fresh agent except Build**, which is one long-running session that compacts as it goes. Discrete at the pipeline level, continuous within the stage where continuity matters.

### Why artifacts instead of one long session

The context that matters for Build is `SPEC.md` + `PLAN.md` + `DECISIONS.md` — not the research transcript or the reasoning about three rejected architectures. A fresh agent reading curated artifacts often has *better effective context* than a compacted session, because compaction is lossy in a way nobody controls.

The deciding factor is **legibility**. In a system where nobody is watching, being able to inspect what the agent believes is worth more than context continuity. When a build comes back wrong, you open `SPEC.md` and see where it lost the plot — instead of doing archaeology on a transcript.

---

## 5. Artifact contract

All agent artifacts live in `.sfo/` inside the project repo. **The rest of the repo is a normal repo.** Nothing about it should look machine-generated.

```
.sfo/
  state.json          # current stage, status, attempt counts
  IDEA.md             # raw capture — append-only
  RESEARCH.md
  SPEC.md             # evolves in place
  QUESTIONS.md
  ANSWERS.md
  DECISIONS.md        # append-only
  PLAN.md
  VERIFY.md
  REVIEW.md
  TEST_CHANGES.md     # append-only
  SUMMARY.md
```

Two invariants make follow-up requests nearly free to add later:

- **`DECISIONS.md` and `TEST_CHANGES.md` are append-only.** They only grow.
- **`SPEC.md` evolves in place**, so a follow-up is a diff against it rather than a new document.

`state.json` holds `current_stage`, `status` (`running` / `awaiting_human` / `failed` / `done`), and attempt counts.

**No database in v1.** The projects directory is the index. When the server arrives, the database mirrors these files and remains a cache — if it is ever wrong, rebuild it from the repos. The moment the database holds something that exists nowhere else, there are two sources of truth.

---

## 6. Decisions and blast radius

Every decision the agent makes that the user did not specify is logged to `DECISIONS.md` with:

- what was decided
- options considered
- reasoning
- `blast_radius`

```
blast_radius: local | structural | external
```

| Value | Meaning | Change cost |
|---|---|---|
| `local` | One component or file | Rebuild that slice — minutes |
| `structural` | Everything sits on top of it (data model, sync vs async, framework) | Rebuild most of the project |
| `external` | Side effects already taken outside the repo (domain registered, service provisioned, OAuth app created) | Cannot be undone by the tool |

This drives the delivery review UI directly: `local` gets a tap-to-change button, `structural` gets a "this means a full rebuild, ~2h — proceed?" confirmation, `external` gets "cannot auto-change; here is what you would do manually."

"Here are the calls I made — tap to change any" is the product's central interaction. It converts blocking into reviewing, which is the app's thesis applied to itself.

### `ambiguity_policy`

When the agent hits a genuine ambiguity mid-build, behavior is configurable:

| Mode | Behavior |
|---|---|
| `autonomous` *(default)* | Decide, record, continue. Surface everything at delivery. |
| `block_on_structural` | Decide `local` things; pause and notify on `structural` or `external`. |
| `block_on_any` | Pause on every real ambiguity. Slow, maximum fidelity. |

Set in the user preferences doc; overridable per idea in the dump itself.

Note that `block_on_structural` is defined entirely in terms of `blast_radius` — one classification serves both features.

**Implementation cost, stated honestly:** the blocking modes break the "Build is one long session" property. A mid-build pause means the build agent writes its question, exits, and state becomes `awaiting_human`; resuming starts a *new* build session that re-orients from `PLAN.md`, `DECISIONS.md`, and the code so far. This works cleanly because of the artifact design, but the resumed agent pays a re-orientation cost. The default mode is therefore also the highest-quality mode — the settings degrade gracefully rather than secretly.

---

## 7. Archetypes and the slot registry

An archetype is **stack + scaffold + verify recipe + delivery path**, expressed as slots with defaults:

```yaml
archetype: app
slots:
  language:  typescript
  framework: expo
  styling:   nativewind
  database:  sqlite-drizzle
  unit:      vitest
  e2e:       playwright
  targets:   web
  delivery:  git-repo      # static-web is a future option
```

**Critical design rule: scaffold fragments and verify recipes attach to slot *options*, not to archetypes.** `sqlite-drizzle` carries its own migration check; `playwright` carries its own smoke harness. Compose any valid combination and verification composes with it. Without this, every new dropdown value requires a hand-written verify path and the dropdown is a lie.

Slot options declare `requires` / `conflicts`, so invalid combinations cannot be selected.

**v1 populates exactly one valid combination** — the one above — but in the registry format. The eventual dropdown UI is a rendering of existing data, not a feature to build from scratch.

### v1 default stack: Expo, web target only

Expo is the long-term default: bespoke single-user software is disproportionately phone software, and one codebase covering web + iOS + Android is exactly the leverage a fixed stack should buy.

But **v1 targets the web build only** — verification runs Playwright against the Expo web output. (Delivery in v1 is a git repo regardless; see below. The web target matters because it is what makes *verification* possible, and it is what a deploy-to-URL delivery adapter will later hang off.) Reasons:

- iOS simulator verification requires macOS + Xcode — effectively impossible in the cloud runner this is heading toward. Android emulators in containers are slow and flaky.
- Native delivery means EAS builds, a dev account, provisioning, TestFlight. The last mile gets *longer*, not shorter.
- Most importantly: **a confounded pass rate is worthless.** If v1 returns 35%, it must be interpretable as a statement about the pipeline, not about Expo's native build surface.

`targets: web+native` becomes a slot option once build and delivery infrastructure exists. Same repo, same code, additive.

### Ideas that do not fit

Anything not matching a populated archetype runs **best-effort**: it still builds, but verification degrades to build + tests only, and `SUMMARY.md` says so plainly. **Never a silent downgrade.**

---

## 8. Verification gate

The linchpin is upstream: **`SPEC.md` must contain machine-checkable acceptance criteria**, written at the Spec stage. Both Verify and Review check against them. Without them, both stages are vibes.

Gate order:

1. Clean install from lockfile in a fresh directory
2. Build succeeds
3. Typecheck and lint clean
4. Tests pass — **and every acceptance criterion has a test**
5. Playwright drives the happy path derived from those criteria
6. **Anti-gaming scan** — no `TODO` / `FIXME` / `not implemented` / mock data / lorem in shipped code paths
7. **On repair attempts, tests may not be weakened** — see adjudication below

The gate is objective and the build agent cannot self-certify. Notification says "done" only on a green gate; otherwise it says "needs you."

### Test change adjudication

Tests are sometimes genuinely wrong, so a blanket freeze is too blunt. Instead:

The build agent **may never silently edit a test.** To change one it files a request. A separate **adjudicator agent** rules on it.

The adjudicator receives: the acceptance criterion, the original test, the proposed test, and the relevant code. It does **not** receive the build transcript — the same principle that makes the adversarial reviewer work.

Its question is narrow: *does the proposed test still verify the same acceptance criterion?* Not "is the code correct."

Verdicts: `approve` / `deny` / `escalate`.

**Auto-denied without adjudication:**
- deleting a test with no replacement
- `.skip` / `.only` on a test covering an acceptance criterion
- removing the last test covering an acceptance criterion

**Two properties that matter more than the adjudicator itself:**

- **Track the rate, not just verdicts.** Every request is logged to `TEST_CHANGES.md` and the count is surfaced at delivery. A build with nine individually-defensible test changes is suspicious in aggregate — a signal no per-decision reviewer can see.
- **Approved changes usually mean the spec was vague.** On approval, the adjudicator notes whether the acceptance criterion itself needs sharpening. That feeds back into spec quality, which is where the real fix lives.

---

## 9. Adversarial review

A fresh agent receives `SPEC.md` and the repo. It **does not receive the build transcript** — that is what makes it adversarial rather than sympathetic.

Prompted to find where reality diverges from spec, with skepticism as the default posture. It hunts for the failure class automated checks miss: code that compiles and passes its own agent-written tests while the core feature is a stub.

Output: findings with severity, and a verdict of `pass` / `repair` / `escalate`.

Both gates must be green before the delivery notification fires. Objective checks catch *broken*; adversarial review catches *hollow*.

---

## 10. Triage

A cheap step immediately after capture — one fast model call, no tools, a few seconds.

**Capture must stay instant.** The moment capture can reject you, the product stops being a place you dump thoughts. Triage therefore **never blocks the pipeline.**

**A note on "notification" in v1:** the CLI has no push channel. Notifications are terminal output plus an optional local desktop notification. The notification *contract* — what fires, when, and what it says — is designed here because it becomes the app's core loop later.

Classifications:

- `ready` — proceed silently
- `underspecified` — proceed, and push a notification immediately: "this one's thin, want to add anything?" Ignore it and the questions round does the work instead.
- `out-of-scope` — **do not reject; renegotiate scope.** For "make an LLM": *"Training a foundation model isn't something I can build — but I could build a fine-tuning harness, or a local inference playground with a chat UI. Want either?"* Rejection is a dead end; a counter-offer is one round trip and often what the user actually wanted.

Triage also performs a **near-duplicate check** against existing ideas. Since this replaces a notes app, catching the idea written down for the fourth time is cheap and valuable.

---

## 11. Clarification round

The Spec stage produces `QUESTIONS.md`. Questions are split into two kinds:

- **Blocking** — the answer changes the architecture; guessing wrong wastes the build
- **Preference** — the agent picks a defensible default, records it as a decision, and proceeds

**Design constraint:** in a terminal, a clarifying question is free because the human is present. Here, every question costs hours of wall-clock. The agent must therefore **never block on something it could decide itself**.

Calibration: fewer than ~5 questions means it is not thinking hard enough. More than ~10 means it is being lazy — pushing decisions to the user that it should own.

**Answer format:** agent-generated multiple choice with written-out tradeoffs, 2–4 options each, plus a free-text override. Answerable with thumbs in 90 seconds. In v1 this renders as an interactive terminal prompt via `sfo answer`.

---

## 12. Runner interface

One function, one implementation:

```
runStage(stage: Stage, workdir: Path) -> StageResult
```

v1 implementation: **headless Claude Code** invoked in `workdir` with the stage prompt.

### Why one runner in v1

Wiring a second harness is a day of work. Getting *unattended two-hour builds to reliably succeed* on that harness — prompt shape, rules format, failure recovery, the thousand small things learned only from watching builds fail — is the bulk of the product, and it is paid **per harness**. Two runners in v1 means tuning two systems before knowing whether one works.

### Keeping the door open

- All house rules live in **`AGENTS.md`** (plain markdown, cross-tool convention), with `CLAUDE.md` symlinked to it.
- **Nothing load-bearing may depend on Claude-specific machinery** (hooks, skills).
- Verification runs as plain shell commands in its own stage, so it is portable by construction.

A second runner (OpenCode / Goose / Codex CLI are the candidates) becomes a second implementation of the interface, not a rewrite.

---

## 13. CLI surface

```
sfo new [--no-run]         # capture (opens $EDITOR or reads stdin), triage, start a run
sfo run <id> [--attach]    # advance until done or awaiting_human
sfo status                 # all projects, their stage, what is blocked
sfo answer <id>            # interactive Q&A, writes ANSWERS, advances
sfo logs <id> [-f]         # tail stage logs
sfo stop <id>              # kill a run, leaving artifacts intact
sfo stage <id> <stage>     # re-run one stage in isolation
```

`sfo stage` is the primary debugging tool and the payoff of artifacts-as-state. When a build comes back hollow, re-run `spec` alone, read the diff, and see exactly where it lost the plot.

### Process model

**`sfo run` detaches by default.** The product's premise is fire-and-forget; a CLI that blocks a terminal for two hours is a slower Claude Code, which is the failure mode this exists to escape. `--attach` streams stage progress for debugging.

`sfo new` is foreground and instant: capture, triage (a few seconds), print the result, then start a detached run. `--no-run` captures only.

**No daemon.** Coordination happens through the filesystem:

- the detached process writes stage logs to `.sfo/logs/<stage>.log` and updates `state.json` atomically
- `sfo status` reads `state.json` across the projects directory — no socket, no IPC
- the CLI is stateless; every command is crash-safe

`state.json` carries `pid` and `heartbeat_at`. If the machine sleeps or reboots mid-build, a `running` state with no live process is detectable, and `sfo run` offers to resume from the last completed stage. Without the heartbeat, a stale `running` is indistinguishable from a live one.

Transitions to `awaiting_human` / `done` / `failed` fire a desktop notification.

Concurrent runs across projects are allowed — separate processes, separate repos, no shared state — with a configurable soft cap (default 2) to respect API rate limits and cost.

The daemon arrives later, and is the server. Files-as-coordination gets crash-safety and inspectability for free in the meantime.

---

## 14. Customization layers

Three layers, in precedence order:

1. **Per-idea, stated in the dump.** *"Build this as a native iOS app in SwiftUI."* The Spec stage reads it. Zero UI, and it is how a person would naturally say it anyway.
2. **User preferences doc** — plain markdown. *"I prefer SwiftUI over Expo, Postgres over SQLite, no Tailwind. ambiguity_policy: block_on_structural."* Prepended to every project's rules.
3. **Archetype slot defaults** — the shipped baseline.

**No settings UI in v1.** Config-as-markdown is more expressive than a settings screen, costs nothing to build, and doubles as the dataset for what a settings UI should eventually contain. When the app arrives, the dropdown renders the slot registry — the underlying model is already correct.

---

## 15. Failure handling

| Failure | Behavior |
|---|---|
| Stage crashes | Retry once, then `failed` with the error in `state.json`. Re-runnable via `sfo stage`. |
| Verify fails | Loop to Build, max 2 repair attempts, then escalate with specific failures. |
| Review returns `repair` | Same loop, shared attempt budget. |
| Review returns `escalate` | Stop, notify with findings. |
| Build hits ambiguity | Per `ambiguity_policy`. |
| Test change requested | Adjudicator rules; auto-deny list applies. |
| Idea does not fit an archetype | Best-effort mode, degraded verification, stated plainly in `SUMMARY.md`. |

**Principle: a stage failure costs one stage, not the project.** Artifacts survive; any stage can be re-run in isolation.

---

## 16. Out of scope for v1

Deliberately excluded, all planned:

- Mobile client (Expo app: capture, question answering, decision review, push)
- Cloud runner and sandboxing
- Accounts, auth, and key management (BYO key)
- Follow-up requests / brownfield changes
- Deploy-to-URL delivery
- Second runner implementation
- Database and index
- Every archetype but one; native targets
- Slot dropdown UI

### Notes on the deferred items

**Follow-ups are the highest-value next feature.** They are only mildly harder than greenfield — the stages do not change shape, verification gets *easier* (a real test suite and regression signal already exist), and the repo's `AGENTS.md` carries conventions forward. They are deferred because they are **downstream**, not because they are hard: their input is greenfield's output. Two invariants already locked make them nearly free — append-only artifacts, and anything after the initial build lands as a **branch + PR**.

**Multi-user reshapes economics and the trust boundary, not the pipeline.** BYO key becomes necessary (you cannot fund strangers' two-hour agent runs), sandboxing goes from convenience to hard security requirement, and the archetype library becomes forkable templates. None of that touches the stage machine.

---

## 17. Open questions

- Exact prompt design per stage — the bulk of real effort, discoverable only by running builds and watching them fail.
- Format of machine-checkable acceptance criteria in `SPEC.md`: prose with IDs, or structured YAML?
- How the adversarial reviewer avoids false positives on deliberate scope cuts already recorded in `DECISIONS.md`.
- Whether `research` earns its cost, or whether the Spec stage should search on demand instead.
- Cost per run — unmeasured, and it determines the funding model when this goes multi-user.
