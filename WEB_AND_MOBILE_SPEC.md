# Web and Mobile Apps — Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-11-12
**Applies to:** contracts (`publish`), the control plane (connections, deploys, databases), preferences, the app (Settings → Connections, cards, done screen)

---

## 1. What changes

sfo builds and delivers web apps and mobile apps, not only CLIs. A web app is
delivered as a URL; a mobile app as an app on your phone. Projects that need
synced data get a database sfo creates for them.

The line from CONTRACTS_SPEC holds: the project declares *what* it is and
needs; sfo owns *whether* it is verified, and here also *where it goes live*.
That takes a little code per kind of delivery (one host, one database
provider, one mobile path), which is accepted so that nothing is left for the
person to set up beyond connecting an account once.

## 2. Decisions

| | Decision | Why |
|---|---|---|
| Web kinds | **Static, synced data and full-stack, all in v1** | The host builds them, so sfo does not care which. |
| Web deploy | **The control plane uploads the project's source to Vercel, which builds it in its own cloud** | One adapter covers static sites, serverless functions and frameworks. The token is used on the control plane only and never reaches a Sprite; project code runs in Vercel's builder, not where the token is. |
| Who can open it | **Anyone with the link** | The production URL; no login. |
| Databases | **sfo always provisions one** for a project that declares it needs synced data, through the provider's API | Nothing to set up per project. The provider is a setting; **Neon** by default (many free small projects; free-tier limits verified before building). Its connection string is set on the Vercel project and given to the project's Sprite, since it is scoped to that one project. |
| Mobile | **A setting: dev build (default), Expo Go, or TestFlight** | People want the app on their phone. Dev builds go to registered devices through EAS internal distribution; Expo Go via EAS Update; TestFlight via EAS Submit. |
| Redeploys | **The first delivery goes live by itself; later ones wait for Publish** | Feedback lands in the repo and the project; the app shows **Publish** to make it live. |
| Connecting accounts | **Settings → Connections, asked for when first needed** | Vercel, Expo, Apple (App Store Connect API key) and the database provider. OAuth where the provider has it, a pasted token otherwise; stored in the vault like the Claude token. A project that needs one it lacks stops before delivery and shows that one Connect button. |

## 3. What a project declares

`CONTRACTS.json` gains `publish`:

```json
"publish": {
  "kind": "web",
  "root": ".",
  "env": ["DATABASE_URL"],
  "database": "postgres"
}
```

- `kind`: `web` or `mobile`. Absent for a CLI (it has `install`).
- `root`: the folder the host builds from.
- `database`: `postgres` when the app keeps synced data; sfo creates one and
  sets `DATABASE_URL`.
- `env`: names the app reads that sfo must set (only ones sfo can supply).

The test-repair prompt gains complete worked examples for a Vite app, a
Next.js app with a database, and an Expo app.

## 4. Delivery

**Web.** After deliver: the control plane takes the project's tracked files
from its Sprite (the existing bundle), creates or reuses a Vercel project,
sets env vars, and creates a production deployment from the files. It waits
for Vercel's build, records the URL, and the card shows **Live** with it.

**Mobile.** After deliver: `eas build` (or `eas update` / `eas submit`, by the
setting) runs on a short-lived deployer Sprite holding the project's bundle
and the Expo and Apple credentials, destroyed afterwards. The done screen
shows the install link (dev build), the Expo Go link, or that it is in
TestFlight.

**Records.** `.sfo/PUBLISH.json`: where it went (URL or build), when, from
which commit, and whether the project has changed since (which the app shows
as **Publish**).

## 5. Risks

- **Mobile credentials beside project code.** `eas build` evaluates the
  project's app config and config plugins on the machine it runs on. A
  model-written project could read the Expo token and App Store Connect key
  there. Mitigations: the deployer Sprite runs nothing but `eas` and is
  destroyed after each build; the Expo token is a robot user's, revocable; the
  App Store Connect key has the narrowest role that can create apps. The
  residual risk is accepted for v1 only with the person's agreement, or v1
  requires a static `app.json` with no local plugins.
- **Spend.** Databases and builds can cost money past free tiers. The done
  screen and Cost show what was provisioned, and a project's budget covers
  its database's expected monthly cost.

## 6. Build order

1. `publish` in contracts, test-repair's examples; Settings → Connections with
   Vercel; web deploy from the control plane; Live on cards; Publish for
   later deliveries.
2. Database provisioning (Neon by default; the provider a setting).
3. Mobile: the deployer Sprite, dev builds by default, Expo Go and TestFlight
   by setting.
