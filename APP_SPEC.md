# The sfo App and Cloud Runner — Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-10-02
**Builds on:** `docs/CLOUD_RUNNER_DESIGN.md`, which supplies the worker
lifecycle, with the two corrections in §3; `CONTRACTS_SPEC.md`;
`MODEL_ACCESS_SPEC.md`; and the deferred §16 of `SOFTWARE_FOR_ONE_SPEC.md`

---

## 1. What this is

You capture an idea on your phone and close the app. It builds in the cloud
with your laptop shut. You get a push notification when it needs you or is
done, answer questions from your phone, see what was built, and send
feedback. Everything sfo does today, from anywhere.

**Decisions from the interview:**

| | Decision |
|---|---|
| Builds run | in the cloud, **one Fly.io Machine (Firecracker microVM) per project run** |
| App | **Expo**: iOS, Android and web from one codebase. Its web target gives agents a browser-checkable feedback loop, and Expo Go gives fast testing on the phone |
| First version | **everything sfo does now**: capture, clarify (with drafts), status, push, results, feedback, retry, check |
| Users | **just you, built multi-user-ready**: every record carries a user id from day one |
| Sign-in | **Sign in with Apple** |
| Paying for models | **your profile's choice**, as on the Mac: subscription token or API key, preference and fallback. Long term sfo is model- and harness-agnostic, so nothing below may assume Claude beyond the existing `Runner` implementation |
| Project home | the run's **own volume**, plus a **private GitHub repo** pushed after every stage |
| Delivery | **repo plus a one-command install** for CLIs; web apps **deployed to a public URL** (anyone with the link); Expo apps through EAS |
| The Mac | **an optional runner**: same sfo, used for hardware checks, macOS-only toolchains, or by choice |

## 2. The pieces

```
 phone (Expo app) ──HTTPS──▶ control plane ──Fly Machines API──▶ worker (microVM per run)
        ▲                     (always reachable)                     │ sfo + Claude Code + toolchains
        └──── Expo push ◀──────────┘ ◀──────── events / state ───────┘ │ volume: the project
                                                                       └──▶ GitHub (push per stage)
```

**The control plane** is the part that's always reachable. It's one small Fly
app (a Node service) with Postgres, set to auto-stop when idle and auto-start
on the next request. It:
- serves the app's API and handles Sign in with Apple;
- stores users, projects (status, stage, notes and next step, as `sfo status`
  computes them), questions and answers, notifications, and secret
  references;
- starts, stops and destroys workers;
- receives each worker's events, and sends Expo push notifications;
- holds secrets: Fly secrets for its own credentials, and per-user ones
  (model credentials, GitHub token) encrypted in Postgres and handed to a
  worker only for its own run.

**Workers** each run one project run: the existing `sfo run` orchestrator,
unchanged in spirit, inside a microVM.
- **The image:** Node, Python, uv, git, the Claude Code CLI, Playwright's
  Chromium, and sfo. The same image serves every project, and a project's
  `CONTRACTS.json` decides what runs inside it.
- **Isolation:** each run is its own microVM, so an agent's arbitrary Bash
  can't reach another project or the control plane. Claude Code's own Bash
  sandbox still applies inside.

**Logs, renders and drafts** go to object storage (Fly's Tigris, which is
S3-compatible), so the app can show screenshots and logs without a worker
running.

## 3. Worker lifecycle (from the design doc, corrected)

As in `docs/CLOUD_RUNNER_DESIGN.md`: create a machine for a run, run the
stages on its local disk, **stop** it while waiting for a person (which
stops compute billing), **start** it when they answer, push and **destroy**
it after delivery, and a sweeper for anything stopped more than 48 hours.

**Correction 1: storage.** By default a Fly Machine's root filesystem is
**reset on every restart**. Fly's docs: *"Stopped Machines that are restarted
are completely reset to their original state."* So the project can't live on
the root disk across a stop and start:
- Each run gets a **Fly Volume**, mounted at `/work`, holding the project,
  `SFO_HOME`, and the uv, npm and Playwright caches. Volumes persist across a
  stop and start.
- **After every stage the worker pushes to the project's private GitHub
  repo.** sfo already commits after each stage. A volume lives on one
  physical host, so if that host is gone, the control plane starts a new
  machine with a new volume, clones the repo, and resumes. That's the
  existing crash-resume (`completedStage`), losing at most one stage.
- At delivery the volume is destroyed along with the machine. The repo
  remains.

**Correction 2: durations and cost.** Builds take **hours**, not 5–25
minutes: ut-tower's build was about 6 hours of compute across its stages.
Health checks and timeouts are sized for hours, and the worker heartbeats to
the control plane, much as `state.json` heartbeats today. A worker is a few
cents an hour while running. A stopped run costs only its volume, about
$0.15 per GB per month.

**Later runs on a delivered project** (`feedback`, `retry`, `check`) start a
fresh machine and volume, clone the repo, and go.

## 4. sfo changes

1. **Where a run executes becomes an interface.**
   `RunHost { start(project, command), stop, resume, destroy, status }`, with
   `LocalHost` (today's detached process on the Mac) and `FlyHost`. The CLI's
   `sfo run`, `retry`, `feedback` and `check` go through it.
2. **The worker reports events.** State changes, parks, questions, renders
   and failures go to the control plane, which keeps them as the project's
   status and sends a push. That's the same information `sfo status` and the
   notification text already compute.
3. **A worker stops itself on a park** (clarify, criterion question, budget,
   plan limit, deferred checks) once it has pushed, and the control plane
   records why. Answering triggers `start`.
4. **The repo is a remote.** Each project gets a private GitHub repo at
   creation, and the commit after each stage is followed by a push. The
   commit guard (secrets and large files) matters even more once the repo is
   remote.
5. **The CLI becomes a client too.** `sfo status` lists cloud projects next to
   local ones. **`sfo install <id>`** clones or pulls a delivered CLI project
   and runs its contract's `install`, which is the "one command" in the
   delivery decision.

## 5. Delivery

- **CLIs:** the repo, plus `sfo install <id>` on any machine with sfo.
- **Web apps:** a contract `install` that deploys to **Cloudflare Pages** (free,
  static, public URL). The URL is the delivered result, and the app's
  results screen links to it. This replaces the local launcher for
  cloud-built web apps; the launcher stays for Mac-run ones.
- **Expo apps** (when sfo builds one): **EAS Build**, installed through Expo Go
  or TestFlight.
- **Hardware projects:** built and gated in the cloud. Their deferred checks
  show in the app as *waiting for: …*, run with `sfo check` on the Mac with
  the board attached.

## 6. The app (Expo)

| Screen | What it does |
|---|---|
| Capture | Type or dictate an idea, with optional budget and access overrides. Submitting is `sfo new`. |
| Projects | Every project: stage, the note `sfo status` would show, the next step, live while running. |
| Questions | Clarify and criterion questions as options plus free text. **Drafts** shown as their light and dark images. Submitting is `sfo answer`. |
| Project | SUMMARY rendered, screenshots, decisions (highest blast radius first), review findings, cost (billed vs plan), logs (`sfo logs`, readable), and actions: **feedback, retry, check, stop**. |
| Settings | Model access (profile), `PREFERENCES.md` editor, budgets and smoke cap defaults, GitHub connection. |

**Push notifications** go through Expo's push service, with the same texts
and next steps sfo already writes. Tapping one opens the relevant screen.

## 7. Multi-user-ready, single user now

Every table and API call is scoped by user id, and secrets are per user.
There's no sign-up page, billing, or quotas: an allowlist holds one Apple
id, yours. Adding people later is adding to the allowlist, then the
features that need it.

## 8. Out of scope for this release

Quotas and billing for other users, teams and shared projects, a non-Fly
`RunHost`, a non-Claude `Runner`, and native (non-Expo) app projects.

## 9. Build order

1. **`RunHost` locally:** extract `LocalHost` from today's detached runs,
   with no behaviour change.
2. **The worker image,** and **`FlyHost`** with a volume per run, push per
   stage, stop on park, start on answer, destroy on delivery, and the sweeper.
   Proven by running one project from the CLI in the cloud.
3. **The control plane:** API, Postgres, Sign in with Apple, worker events,
   Expo push.
4. **The app:** projects, project detail, capture, questions with drafts,
   then actions.
5. **Delivery:** GitHub repos, `sfo install`, Cloudflare Pages deploys for
   web projects.
6. **One idea captured on the phone, built in the cloud with the laptop shut,
   answered from the phone, delivered** before this counts as done.

## 10. Sources for the Fly.io facts used here

- [Fly Volumes overview](https://fly.io/docs/volumes/overview/): volumes
  persist across restarts.
- [Restart apps or Machines](https://fly.io/docs/apps/restart/), and
  [`persist_rootfs`](https://community.fly.io/t/your-rootfs-reboot-resistant-try-persist-rootfs/26146):
  the root filesystem is reset by default, and persisting it isn't
  recommended for critical data.
