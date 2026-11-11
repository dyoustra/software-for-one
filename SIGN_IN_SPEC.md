# Sign-in — Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-11-11
**Changes:** CONTROL_PLANE_SPEC.md §2 (sign-in), §5 (auth routes)

---

## 1. What changes

Sign in with Apple stops being the only way in. It was the default for one
person on an iPhone, and it cannot work for the web build on `localhost`
(Apple needs a registered HTTPS return address), nor for anyone without an
Apple ID. In order:

1. **GitHub sign-in**, now: on the app, the web build and the CLI.
2. **Passkeys**, once sfo has a domain of its own. A passkey is bound to the
   domain it was made for, forever: one made for `sfo-control.fly.dev` would
   never work after a move. So the domain comes first (none is owned yet;
   ~$10/yr at Cloudflare's registrar, then one DNS record).

Apple stays, for the iPhone.

## 2. Decisions

| | Decision | Why |
|---|---|---|
| GitHub flow | **GitHub's device flow, on every client** | A code to approve at github.com/login/device; the client receives the token. No callback address to register anywhere, so it works on `localhost`, in the app and in a terminal alike. A redirect flow for the app can come later if the code step feels slow. |
| Trusting a GitHub token | **Only one GitHub issued to our App**, checked with `POST /applications/{client_id}/token` (client id and secret) | A token from any other app also answers `GET /user`; accepting one would let any app that ever got a person's token sign in as them. |
| Identity | **GitHub's numeric user id**, never the username | A username can be changed, and the old one registered by someone else. |
| Who gets in | **Allowlist**: `SFO_ALLOWED_GITHUB_IDS`, beside `SFO_ALLOWED_APPLE_IDS` | Anyone signing in can make projects, and every project is a Sprite billed to the owner. Open sign-up waits for per-user quotas and an outside security review of isolation between users. |
| Several methods, one account | **Added while signed in**, from Settings or the CLI | An account is created by the first method used; others are linked only by someone already signed in to it. Never by matching email addresses: that is a classic takeover. A method already linked to another account cannot be linked again. |
| Web token storage | **The browser's localStorage** on web; the Keychain on iOS | The web build is for development now; a cookie-based session comes with a deployed web app. |
| Cross-origin | **CORS for the web build's origins only**: `SFO_WEB_ORIGINS`, default `http://localhost:8081` | The web build calls the control plane from another origin; nothing else may. |

## 3. Data

```
identities  user_id, provider ('apple' | 'github'), subject, created_at
            UNIQUE (provider, subject)
```

`users.apple_sub` moves into `identities` (provider `apple`), and stays as a
column only until the migration has run everywhere.

## 4. API

| | |
|---|---|
| `GET /github/app` | (exists) the App's client id, for the device flow |
| `POST /auth/github` | `{ githubToken, deviceName }` → `{ token }`: signs in, or creates an account for an allowlisted GitHub id with no account yet |
| `POST /identities/github` | signed in; `{ githubToken }`: links that GitHub account to this one |
| `GET /identities` | signed in; which methods this account has |

`/approve` (the CLI's device-code page) offers GitHub beside Apple.

## 5. Clients

- **App and web build**: the sign-in screen offers Sign in with Apple (iOS
  only) and Sign in with GitHub (everywhere): it shows GitHub's code, opens
  github.com/login/device, and waits. Settings lists the linked methods and
  adds GitHub.
- **CLI**: `sfo login` unchanged; the approval page gains GitHub.

## 6. Build order

1. Server: identities (with the Apple migration), the token check, `/auth/github`,
   linking, CORS, `/approve` with GitHub.
2. App: storage that works on web, GitHub sign-in on every platform, linking in
   Settings.
3. Link your GitHub account to your existing account; then the web build is
   signed in and iterable.
4. Later: a domain, then passkeys.
