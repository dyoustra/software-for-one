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
| Builds run | in the cloud, **one Fly.io Sprite (a persistent Firecracker VM) per project** |
| App | **Expo**: iOS, Android and web from one codebase. Its web target gives agents a browser-checkable feedback loop, and Expo Go gives fast testing on the phone |
| First version | **everything sfo does now**: capture, clarify (with drafts), status, push, results, feedback, retry, check |
| Users | **just you, built multi-user-ready**: every record carries a user id from day one |
| Sign-in | **Sign in with Apple** |
| Paying for models | **your profile's choice**, as on the Mac: subscription token or API key, preference and fallback. Long term sfo is model- and harness-agnostic, so nothing below may assume Claude beyond the existing `Runner` implementation |
| Project home | the **Sprite's own disk**, plus a **private GitHub repo** pushed after every stage |
| Delivery | **repo plus a one-command install** for CLIs; web apps **deployed to a public URL** (anyone with the link); Expo apps through EAS |
| The Mac | **an optional runner**: same sfo, used for hardware checks, macOS-only toolchains, or by choice |

## 2. The pieces

```
 phone (Expo app) ──HTTPS──▶ control plane ──Sprites API──▶ worker (Sprite per project)
        ▲                     (always reachable)                     │ sfo + Claude Code + toolchains
        └──── Expo push ◀──────────┘ ◀──────── events / state ───────┘ │ disk: the project  
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
- **The environment:** Sprites take no custom image. Their base (Ubuntu)
  already has Node, Python, uv, git and gh; a setup step adds sfo, Claude
  Code from its own installer (the Sprite's bundled copy lags and cannot
  update itself), and Playwright's Chromium when a contract needs it. A
  project's `CONTRACTS.json` decides what runs inside it.
- **Isolation:** each project is its own VM, so an agent's arbitrary Bash
  can't reach another project or the control plane. Claude Code's own Bash
  sandbox still applies inside.

**Permissions follow the host.** On a worker, the VM is the boundary:
stages run with `--permission-mode bypassPermissions` and without Claude
Code's Bash sandbox, so no command stalls waiting for an approval nobody can
give. The worst an agent can do is damage its own run. On the Mac, stages
keep `acceptEdits` and the sandbox: a probe showed `bypassPermissions` lets
both Bash and the Write tool change files anywhere in the person's home.

What the VM does not contain is what is handed to it, so every credential a
worker holds is scoped to that run: a GitHub App installation token for the
project's repo alone (an hour long, refreshed by the control plane), a
control-plane token valid only for that run, and the model credential the
stage needs anyway.

**Logs, renders and drafts** go to object storage (Fly's Tigris, which is
S3-compatible), so the app can show screenshots and logs without a worker
running.

## 3. Worker lifecycle: Sprites

`docs/CLOUD_RUNNER_DESIGN.md` planned Fly Machines: create one per run, stop
it while waiting for a person, start it on an answer, destroy it after
delivery, and sweep anything stopped over 48 hours. A Machine's root
filesystem is reset on restart, so that plan also needed a Fly Volume per run.
**Fly Sprites do all of that themselves**, and are what sfo uses:

- **One Sprite per project**, created at `sfo new`. Its disk persists across
  every pause: no volume to attach, no stop or start to call.
- **It pauses itself** about 30 seconds after the last activity it
  recognises, and wakes on the next request. A stage's outgoing model calls
  are not activity it recognises, so **every sfo heartbeat renews a
  five-minute Sprite task** (`holdAwake`). A run that parks or dies stops
  renewing, and the Sprite pauses within five minutes: no stop call, and no
  stuck worker billing for hours.
- **Paused, a Sprite costs only its disk** (about $0.02 per GB per month).
  Running, it bills the CPU actually used, which suits builds that spend most
  of their time waiting on a model.
- **After every stage the worker pushes to the project's private GitHub
  repo.** The Sprite's disk is the working copy; the repo is the backup, and
  what later runs and `sfo install` clone.
- **Checkpoints** (about a second, copy-on-write) are available for rolling
  a project back; sfo does not use them yet.
- **After delivery** the Sprite stays, paused, for `feedback`, `retry` and
  `check`, and is destroyed after 30 idle days (a sweep by the control
  plane). Its repo remains.

Builds take **hours**, not the design doc's 5–25 minutes: ut-tower's build
was about 6 hours of compute across its stages.

## 4. sfo changes

1. **Where a run executes becomes an interface.**
   `RunHost { start(project, command), stop, resume, destroy, status }`, with
   `LocalHost` (today's detached process on the Mac) and `SpriteHost`. The CLI's
   `sfo run`, `retry`, `feedback` and `check` go through it.
2. **The worker reports events.** State changes, parks, questions, renders
   and failures go to the control plane, which keeps them as the project's
   status and sends a push. That's the same information `sfo status` and the
   notification text already compute.
3. **A worker parks by finishing** (clarify, criterion question, budget,
   plan limit, deferred checks) once it has pushed: it stops renewing its
   task and the Sprite pauses. The control plane records why, and an answer
   wakes the Sprite with the next `sfo run`.
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
- **Web apps:** a contract `install` that deploys to the person's preferred
  host, read from `PREFERENCES.md`; the default is **Vercel**, to the
  person's own account through a token in Settings. A public URL anyone with
  the link can open. sfo has no host built in, so Cloudflare Workers or
  anything else is a one-line preference change. The URL is the delivered
  result, and the app's results screen links to it. This replaces the local launcher for
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

**Model access for other people is not the same as yours.** Anthropic's
consumer terms (enforced since January 2026) allow a Pro or Max login only
in Claude Code and claude.ai for the person's own use; a product routing
other people's work through their subscription breaks them, however the
login is collected. Google bans the same thing and suspends accounts for it.
So for anyone but you:
- **an API key in Settings** is the default;
- **a runner they own** (their computer, or a Sprite on their own Fly
  account, signed in to Claude Code themselves) is how they use a
  subscription; the app and control plane only coordinate;
- **OpenAI's "Sign in with ChatGPT"** (DevDay, September 2026) is the one
  sanctioned way for a third-party app to spend a person's plan: self-serve
  for open-source and locally run apps, by application for hosted ones. It
  needs a non-Claude `Runner`.

## 8. Out of scope for this release

Quotas and billing for other users, teams and shared projects, a
`RunHost` beyond the Mac and Sprites, a non-Claude `Runner`, and native (non-Expo) app projects.

## 9. Build order

1. **`RunHost` locally:** extract `LocalHost` from today's detached runs,
   with no behaviour change.
2. **Sprites by hand:** sfo on a Sprite with VM confinement and
   `holdAwake`, one real project run from the CLI to delivery. Then
   **`SpriteHost`**: create and set up a Sprite per project, push per stage,
   wake on answer, and the 30-day sweep.
3. **The control plane:** API, Postgres, Sign in with Apple, worker events,
   Expo push.
4. **The app:** projects, project detail, capture, questions with drafts,
   then actions.
5. **Delivery:** GitHub repos, `sfo install`, deploys to the preferred host
   for web projects.
6. **One idea captured on the phone, built in the cloud with the laptop shut,
   answered from the phone, delivered** before this counts as done.

## 10. Sources

- [Sprites](https://fly.io/sprites/), [lifecycle and
  persistence](https://docs.fly.io/sprites/concepts/lifecycle), [keeping a
  Sprite running](https://docs.fly.io/sprites/keeping-sprites-running)
- [Fly Volumes overview](https://fly.io/docs/volumes/overview/) and
  [`persist_rootfs`](https://community.fly.io/t/your-rootfs-reboot-resistant-try-persist-rootfs/26146),
  for why Machines alone were not enough
- Anthropic's third-party subscription terms:
  [GIGAZINE](https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block/)
- Google's Gemini CLI enforcement:
  [discussion #20632](https://github.com/google-gemini/gemini-cli/discussions/20632)
- OpenAI's Sign in with ChatGPT for third-party apps:
  [XenoSpectrum](https://xenospectrum.com/en/chatgpt-sign-in-subscription-apps/)
