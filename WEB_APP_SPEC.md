# sfo's own web app, deployed — spec

Status: agreed 2026-11-16. Covers TODO "Cookie session for a deployed web app".

## 1. Addresses

| Address | Serves | Host |
|---|---|---|
| `sfo.dannyyoustra.com` | the web app (Expo web export), and the `apple-app-site-association` file | Vercel |
| `api.sfo.dannyyoustra.com` | the control plane: API, approval page (`/approve`), `/health` | Fly (`sfo-control`) |
| `sfo-control.fly.dev` | the control plane, unchanged; Sprites set up before the move keep using it | Fly |

- The passkey relying party stays `sfo.dannyyoustra.com`. Passkeys are accepted from `https://sfo.dannyyoustra.com` (the web app) and `https://api.sfo.dannyyoustra.com` (the approval page). Both are under the rp ID, so existing passkeys keep working.
- `SFO_PUBLIC_URL` becomes `https://api.sfo.dannyyoustra.com`. The CLI's approval link and new Sprites' event URL use it.
- `SFO_WEB_ORIGINS` becomes `https://sfo.dannyyoustra.com,http://localhost:8081`.

## 2. Clients follow the move

- **CLI.** `DEFAULT_CONTROL_URL` becomes `https://api.sfo.dannyyoustra.com`. A saved `control.json` holding `https://sfo.dannyyoustra.com` is rewritten to the new address on the next command. The token is unchanged, so nobody is signed out.
- **App.** `API_URL` defaults to `https://api.sfo.dannyyoustra.com`.

## 3. Session cookie (web app only)

**Opting in.** A sign-in request carrying `x-sfo-session: cookie` from an allowed `https` web origin gets its device token as a cookie, not in the body. The answer is `{ "cookie": true }`. This applies to:
- `/auth/apple`
- `/auth/passkey`
- `/auth/github/wait`

**The cookie:**
- Named `__Host-sfo`.
- `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=30 days`.
- Host-only on `api.sfo.dannyyoustra.com`. Page scripts never see it.

**Device row.** The device is marked `cookie` (migration v14). A cookie device is accepted only from the cookie, never as a bearer token.

**Each request:**
- With no `Authorization` header, the cookie is used.
- Methods other than GET and HEAD must carry an `Origin` in `SFO_WEB_ORIGINS`; otherwise the answer is 403. This blocks cross-site request forgery, including from other `dannyyoustra.com` subdomains, which `SameSite` treats as same-site.
- Idle for more than 30 days: the device is revoked and the answer is 401.
- Last renewed more than a day ago: the cookie is set again, which slides the 30 days.

**Signing out.** `DELETE /devices/current` revokes the device and clears the cookie. Revoking the device from another device signs the browser out on its next call.

**New route.** `GET /auth/session` answers 200 when signed in, 401 when not. The web app asks it on load.

**CORS.** Credentials are allowed for the listed origins, and the `x-sfo-session` header is allowed.

**localhost.** The dev build is unchanged: token in localStorage, bearer header.

## 4. Web app sign-in

On `sfo.dannyyoustra.com`, the web app offers three ways to sign in:
- **Passkey.**
- **GitHub**, using the code flow.
- **Apple**, through Apple's JS. It uses Services ID `com.youstra.sfo.web` with return URL `https://sfo.dannyyoustra.com/sign-in`.

## 5. Deploying

`npm run deploy` deploys the control plane, then the web app:
- The web step runs `expo export -p web`, adds `vercel.json` (rewrites for dynamic routes, a JSON content type for the association file), and runs `vercel deploy --prod`.
- It uses the Vercel CLI's login on this Mac.
- No token is held by sfo.

## 6. Cutover order

1. **DNS:** `api.sfo` CNAME → `sfo-control.fly.dev`, DNS-only. Then `fly certs add api.sfo.dannyyoustra.com`.
2. **Deploy** the control plane (both origins, new public URL), CLI and app.
3. **Vercel:**
   - `vercel login` (once).
   - Create the project.
   - Deploy.
   - `vercel domains add sfo.dannyyoustra.com`.
4. **DNS:** `sfo` → Vercel (CNAME `cname.vercel-dns.com`, DNS-only). Then remove the Fly cert for `sfo.dannyyoustra.com`.
5. **Apple portal:** add domains `sfo.dannyyoustra.com` and `api.sfo.dannyyoustra.com` to `com.youstra.sfo.web`, with return URLs `https://api.sfo.dannyyoustra.com/approve` and `https://sfo.dannyyoustra.com/sign-in`.
6. **Verify:**
   - The association file is served from Vercel.
   - The web app signs in with a passkey and with GitHub.
   - A cookie request from a foreign origin is refused.
   - The CLI's saved address has moved.
