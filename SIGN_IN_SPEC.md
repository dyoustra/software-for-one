# Sign-in — Spec

**Status:** GitHub sign-in built; passkeys wait for a domain
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
| GitHub flow | **GitHub's device flow, run by the control plane, for every client** | A code to approve at github.com/login/device. No callback address to register anywhere, so it works on `localhost`, in the app and in a terminal alike. The control plane runs it because GitHub's device endpoints refuse browsers (no CORS): the client asks it to start, shows the code, and waits on a request it holds while it polls GitHub at GitHub's pace. |
| Trusting GitHub | **The control plane obtains the token itself** | No client ever hands the server a GitHub token, so there is no "was this issued to our App?" question to answer: the token came from our own client id, to the server. |
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

`users.apple_sub` moves into `identities` (provider `apple`), and `users` is
rebuilt without it.

## 4. API

| | |
|---|---|
| `POST /auth/github/start` | → `{ flow, userCode, verificationUri }`: GitHub's code to show |
| `POST /auth/github/wait` | `{ flow, deviceName }`, held until approved → `{ token }` (signs in, or creates an account for an allowlisted GitHub id with no account yet), or 202 to ask again. Signed in, with `link: true`, it links that GitHub account to this one instead |
| `GET /identities` | signed in; which methods this account has |

`/approve` (the CLI's device-code page) stays Apple-only for now: a GitHub
button there would need its own device flow inside a device flow. The CLI
signs in with GitHub directly instead (`sfo login --github`).

## 5. Clients

- **App and web build**: the sign-in screen offers Sign in with Apple (iOS
  only) and Sign in with GitHub (everywhere): it shows GitHub's code, opens
  github.com/login/device, and waits. Settings lists the linked methods and
  adds GitHub.
- **CLI**: `sfo login --github` shows GitHub's code and waits; already signed
  in, it adds GitHub to the account instead. `sfo login` (Apple, through the
  approval page) unchanged.

## 6. Build order

1. Server: identities (with the Apple migration), the GitHub device flow
   (`/auth/github/start` and `/wait`, with linking), `/identities`, CORS.
2. App: storage that works on web, GitHub sign-in on every platform, linking in
   Settings.
3. Link your GitHub account to your existing account; then the web build is
   signed in and iterable.
4. Later: a domain, then passkeys.
