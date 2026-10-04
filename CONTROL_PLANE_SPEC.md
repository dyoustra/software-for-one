# Control Plane — Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-10-04
**Builds on:** `APP_SPEC.md` §2–§9 (this is build step 3), `src/core/cloud.ts`
(the orchestration it serves), `docs/RUNBOOK.md` runs 4–5

---

## 1. What this is

The one part of sfo that is always reachable. It holds the project index, each
person's credentials and push tokens, creates and drives a Sprite per project,
hears from those Sprites when something happens, and pushes a notification.
The Expo app and the `sfo` CLI are both clients of the same structured API, so
a project started on the phone shows in `sfo status`, and the reverse.

## 2. Decisions

| | Decision | Why |
|---|---|---|
| Runs on | **a Fly Machine**, stopped when idle | Deployed from the repo, health-checked, restarted on failure; it holds every key, so it must be rebuildable and never edited by hand. A Sprite is a mutable computer: right for builds, wrong here. |
| Idle | **stops; starts on the next request** (~$0.15/mo stopped) | Safe under one rule: **every action finishes inside its request.** Nothing is scheduled; builds run on Sprites. |
| Code | **TypeScript, in this repo**, sharing `src/core` | The heart of it is `cloud.ts`, already written and tested; app and CLI cannot drift from one implementation. |
| Data | **SQLite** on a Fly Volume, **Litestream** to Tigris | Tiny data, one writer, no database server. Postgres when there are several app servers or many concurrent users; the migration stays contained because all access is in one module. |
| Not Supabase | | It would supply Apple sign-in and realtime, both small to build for one user, at the cost of a second platform and a second runtime (Deno) for the code that matters most. |
| API | **Structured everywhere** | Questions as JSON, answers and feedback as posts, logs as a stream. The CLI uses it too and no longer needs the `sprite` CLI. No remote terminals. |
| Worker → control plane | **a per-project token** | Created with the Sprite, stored on it, good only for that project's events and uploads. The worst a hostile agent can do with it is report false status for its own project. |
| Drafts, renders | **uploaded to object storage** (Tigris) by the worker | The app shows them with the Sprite asleep, and after it is destroyed. Logs are streamed live from the Sprite, only while someone watches. |
| CLI sign-in | **device code**, like `gh auth login` | `sfo login` shows a code; approve where you are signed in with Apple; the waiting CLI receives a token for the Keychain, revocable per device. |
| Credentials | **per user, encrypted** in the database | AES-256-GCM, key held as a Fly secret. GitHub by connecting a GitHub App in one tap; Claude carried up from the Mac's Keychain by `sfo login`, or an API key pasted by someone with no Mac. |
| Existing projects | cloud ones imported, local ones stay local | `sfo login` uploads `cloud.json`; `sfo status` keeps listing local projects beside the control plane's. |

## 3. The rule: every action finishes inside its request

Fly stops an idle Machine, but never one with a request in flight. So nothing
runs after a response:

- **Creating a project** holds its request for the whole setup (~40 s: Sprite,
  setup, credentials, capture, repo). The app shows the steps as they happen
  (the response streams progress); the CLI prints them.
- **Worker events** are requests: they wake the Machine, are stored, push
  their notification, and return.
- **Log streams** are requests held open while someone watches.

A request cut off by a crash leaves a project in `creating`; the next request
about it finishes or cleans up (a Sprite with no captured project is
destroyed, as `newCloudProject` already does on failure).

## 4. Data

```
users        id, apple_sub, created_at
devices      id, user_id, name, token_hash, created_at, last_used_at, revoked_at
device_codes code, user_code, user_id?, device_id?, expires_at
credentials  user_id, kind (claude_token | anthropic_api_key | github_installation), ciphertext, nonce, created_at
projects     id, user_id, sprite, repo?, status ('creating' | 'ready' | 'destroyed'),
             summary (JSON: what `sfo status --json` reports), created_at, updated_at
worker_keys  project_id, token_hash
push_tokens  user_id, expo_token, created_at
events       id, project_id, kind, payload (JSON), at
artifacts    project_id, kind (draft | render), path, object_key, at
```

Every row is reached through `user_id`. Tokens are stored hashed.

## 5. API

Sessions: `Authorization: Bearer <token>`, from Sign in with Apple (app) or a
device token (CLI).

| | |
|---|---|
| `POST /auth/apple` | identity token → session (verified against Apple's keys; audience is the app or the web service id) |
| `POST /auth/device` | → `{ user_code, verify_url, device_code }` |
| `GET /auth/device/:device_code` | held open until approved or expired → `{ token }` |
| `GET /approve` | one page: Sign in with Apple, then approve or deny a code (until the app has the same screen) |
| `GET/DELETE /devices` | list and revoke |
| `PUT /credentials/claude` | from `sfo login`, after the person confirms |
| `PUT /credentials/api-key` | pasted |
| `GET /github/connect` → `/github/callback` | GitHub App authorization |
| `POST /projects` | `{ idea, budget? }` → streams progress, ends with the project |
| `GET /projects` | every project of this user, with its summary |
| `GET /projects/:id` | summary, open questions, drafts and renders (short-lived links), decisions, findings, cost |
| `GET /projects/:id/questions` | the open questions as `QUESTIONS.json` holds them |
| `POST /projects/:id/answers` | `{ "Q-001": "B", … }`, then the run resumes (`answerFrom`'s rules: all open questions, only those) |
| `POST /projects/:id/feedback` | `{ text }`, queued behind any feedback already applying |
| `POST /projects/:id/run`, `/retry`, `/stop` | as the CLI commands |
| `GET /projects/:id/log` | server-sent events: the current stage's log, rendered as `sfo logs` renders it |
| `GET /projects/:id/bundle` | the project's git bundle, for `pull`, `check`, `install` |
| `DELETE /projects/:id` | destroy the Sprite (the repo stays) |
| `POST /push-tokens` | register an Expo push token |
| `POST /workers/:id/events` | worker token; `{ kind, payload }` |
| `POST /workers/:id/uploads` | worker token; → a presigned upload URL for a draft or render |

## 6. Workers

`newCloudProject` gains two things for the Sprite: `SFO_CONTROL_URL` and the
project's worker token (stored like the other secrets, on stdin, mode 600).

sfo on the Sprite then reports through a new `Notifier`, beside the macOS one:
when a run parks, finishes, fails or crashes, it posts the same text and next
step that notifications already carry, plus the project's summary. Drafts (after
spec) and renders (after smoke) are uploaded through presigned URLs, so the
Sprite holds no storage credentials. A failed post is logged and survived.

## 7. Credentials

- **GitHub**: a GitHub App owned by the sfo account, permissions limited to
  creating repositories and managing deploy keys. Connecting stores the
  user-to-server token, refreshed as needed. Pushes still use the per-repo
  deploy key; the GitHub token never reaches a Sprite.
- **Claude subscription**: only through the person's own machine. `sfo login`
  reads the token their profile names (`cloud-token`), says what it is about to
  upload, and uploads it. Anthropic does not let third parties offer a Claude
  sign-in, so there is no app flow for it.
- **API key**: pasted in the app's Settings, or uploaded by `sfo login` if the
  profile prefers it.

## 8. The CLI

- `sfo login` (device code), then uploads `cloud.json`'s projects and the
  credentials above, asking first.
- With a control plane configured, cloud commands become API calls:
  `new` (default cloud), `status` (control plane's projects, plus local ones),
  `answer` (fetch questions, ask in the terminal, post), `feedback` (editor,
  post), `run`, `retry`, `stop`, `logs -f` (the event stream), `pull`/`check`/
  `install` (the bundle), `destroy`.
- Without one, today's direct path (the `sprite` CLI) keeps working.

## 9. Push notifications

Expo's push service, to every token the user registered. Sent for: needs you
(clarify, a criterion question, budget, plan limit, checks waiting for
hardware), done, failed, crashed. Tapping one opens that project.

## 10. Out of scope for this step

The Expo app itself (step 4), sign-up for anyone but the allowlisted Apple id,
billing and quotas, proxying live terminals, Postgres, and a second region.

## 11. Build order

1. **Server skeleton** on Fly: health check, SQLite and Litestream, deployed
   from the repo, stopping when idle.
2. **Auth**: Sign in with Apple, the device-code flow and approval page,
   `sfo login`.
3. **Credentials**: encryption, `sfo login` upload, the GitHub App.
4. **Projects**: `cloud.ts` over the Sprites REST API, creating inside the
   request, the project endpoints, import from `cloud.json`.
5. **Workers**: the event notifier, worker tokens, uploads; Expo push.
6. **CLI** on the API; `logs -f` over the event stream.
7. **One real run driven entirely through the control plane** — created,
   answered and installed from the CLI with the laptop shut between — before
   this counts as done. Then the Expo app.

## 12. Cost

The Machine, stopped: about $0.15/month for its volume; running, cents. Tigris:
pennies at this size. The Sprites and model usage are as before.
