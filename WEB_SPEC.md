# Web Apps, Kinds and Settings — Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-09-30
**Depends on:** everything through `FEEDBACK_SPEC.md`; `SOFTWARE_FOR_ONE_SPEC.md`
§7 (archetypes as slots) and §14 (user preferences)

---

## 1. Direction

sfo builds more than one kind of thing. CLIs work end to end, and the next
kind is web apps. After that come mobile apps, browser extensions, desktop
apps, and programs for DIY hardware. Two principles from this interview shape
all of it:

- **What gets built is a choice with defaults, and the defaults are the
  person's settings.** They're not constants in sfo. The first release builds
  one option per choice, inside a structure that already knows the others.
  The eventual app's settings page is a rendering of that structure, which is
  the original spec's slot registry, finally built.
- **Ambiguity is asked about once, at clarify,** and only when the idea
  itself doesn't settle it.

## 2. The registry: kinds, archetypes, slots

```
kind        archetype            slots (options; * = built in this release)
cli         cli-python*          —
            cli-node*            —
web         web-vite-react*      data:     browser*, local-sqlite, hosted
            web-nextjs           delivery: local-launcher*, deploy
            web-expo
mobile      (none yet)
extension   (none yet)
desktop     (none yet)
hardware    (none yet)
```

- Each archetype and each slot option carries `available: true|false`, its
  own verify recipe, and its own scaffold notes, attached to the option and
  not to the archetype (original spec §7).
- `ARCHETYPE.json` grows to
  `{"kind":"web","archetype":"web-vite-react","slots":{"data":"browser","delivery":"local-launcher"},"why":"…"}`.
  Old CLI records (with no `kind` or `slots`) still read correctly.
- Choosing an option that isn't available fails validation, and the error
  says what is.

## 3. Settings

`profile.json` gains per-kind defaults:

```json
"defaults": {"web": {"archetype": "web-vite-react", "data": "browser", "delivery": "local-launcher"}}
```

- `sfo settings` shows every kind, archetype and slot, which ones are
  available, and your defaults.
- `sfo settings set web.data browser` changes a default, and refuses an
  option that isn't built yet.
- Out of the box: `web-vite-react`, `browser`, `local-launcher`.

## 4. How spec chooses

1. **Kind.** From the idea. If the idea names one ("as a web app", "a Chrome
   extension"), that decides it. If the idea could reasonably be more than
   one kind and doesn't say, that's a `blocking` clarify question. There's no
   preference setting for this.
2. **A kind with no available archetype** (mobile, extension, …) is a
   `blocking` question: build the nearest kind sfo supports (say which, and
   what's lost), or stop. Never a silent downgrade.
3. **Archetype and slots** come from your defaults. When the idea needs
   something the default can't do (a list two people edit needs sync), spec
   **picks the option the idea needs** and records it as a `structural`
   decision. It only becomes a question when that option isn't built yet:
   build with the limitation stated, or wait.

## 5. `web-vite-react`

A single-page app: Vite, React and TypeScript. Nothing server-side.

**Layout that test-write and test-repair set up:**
- unit tests as `tests/sNN-*.test.ts` (Vitest, with jsdom where needed)
- browser tests as `tests/e2e/sNN-*.spec.ts` (Playwright, Chromium)
- `playwright.config.ts` whose `webServer` builds and serves the app with
  `vite preview` on `$PORT`
- a `bin` launcher (§7), and the usual `lint` and `typecheck` scripts

**Recipe:**

| Step | Command | Scoped to the slice |
|---|---|---|
| install | `npm ci` | — |
| lint | `npm run lint` | — |
| typecheck | `npm run typecheck` | — |
| unit | `npx vitest run --exclude 'tests/e2e/**' --exclude 'smoke/**'` | the slice's `tests/sNN-*` files |
| browser | `npx playwright test` | the slice's `tests/e2e/sNN-*` files |

- **Each slice's gate runs its own Playwright tests** against a real
  Chromium, on a free port the gate picks and passes as `PORT`, so gates
  can't collide.
- **Recipes gain per-step scoping:** each scoped step takes only the slice's
  files that match its own pattern.
- **Browsers:** test-repair runs `npx playwright install chromium` once, and
  the sandbox allows writes to `~/Library/Caches/ms-playwright`.
- **Data slot `browser`:** IndexedDB, through a small storage module that
  tests can fake. Losing data when the browser is reset is a limitation
  SUMMARY must state.

## 6. Seeing it

- **Presentation** is `visual` by default for web apps.
- **Renders:** after smoke, Playwright screenshots each invocation (a route
  plus a short script of actions) at desktop (1280×800) and phone (390×844)
  sizes, in light and dark (`prefers-color-scheme`). Review looks at them,
  and SUMMARY shows them.
- **Drafts at clarify,** when the look matters, are static HTML mockups,
  screenshotted the same way. The person picks one, and it becomes the
  visual reference that test-write's snapshot tests lock in.
- **Smoke:** the browser is a platform seam. `smoke/` holds Playwright specs
  that run the **production build** through the main flow with no console
  errors, plus any external services the app calls.

## 7. Delivery slot `local-launcher`

- The app's `bin` is a small Node script. It serves the production build with
  `vite preview` on a free port, opens the browser (`--no-open` just prints the
  URL), and stays in the foreground until Ctrl-C.
- Deliver runs `npm run build`, then `npm link`. The check from a fresh login
  shell does more than `--help`: it starts the launcher with `--no-open`,
  fetches the URL and expects a 200, then stops it.

## 8. Build order

1. The registry: kinds, archetypes, slots and availability. `ARCHETYPE.json`
   v2 with CLI compatibility. `sfo settings`.
2. Spec and clarify prompts: choosing the kind, unsupported kinds, deviating
   from defaults.
3. Per-step recipe scoping, and a free port for the gate.
4. `web-vite-react`: recipe, test-write and test-repair prompts, Playwright
   install, sandbox paths.
5. Web renders and drafts through Playwright screenshots.
6. The launcher and its install check.
7. **One real web idea, end to end,** before this counts as done.

## 9. Out of scope for this release

The other archetypes and slot options (listed as unavailable); deploying to a
URL; mobile, extension, desktop and hardware kinds beyond the clarify message;
the sfo app's settings page, which will render this registry.
