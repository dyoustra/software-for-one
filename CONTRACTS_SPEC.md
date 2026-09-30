# Project Contracts — Spec

**Status:** Design approved, pre-implementation
**Date:** 2026-09-30
**Replaces:** the earlier draft of this file, which proposed a registry of
kinds, archetypes and slots, with a verify recipe per archetype in sfo's code
**Depends on:** everything through `FEEDBACK_SPEC.md`; `SOFTWARE_FOR_ONE_SPEC.md` §14

---

## 1. What sfo is

sfo is **Claude Code in a loop, plus an independence layer.** It adds:
- tests written before the code by another agent, and locked;
- a gate that **sfo runs itself**;
- an adjudicator for disputed tests;
- adversarial review;
- checks against reality.

That layer is the product, and none of it depends on what kind of thing is
being built.

What *does* depend on the kind is **how** to check it: which commands install
it, lint it, test it, show it, and exercise it for real. Until now that
knowledge was **code in sfo**, one hard-coded recipe per archetype. That
doesn't scale: there are endless kinds (web apps, browser extensions, iOS
apps, firmware for an e-ink board, a Raspberry Pi service), and each one would
need new sfo code.

**The line this spec draws:** sfo owns *whether* the work is verified. The
project owns *how*, by declaring its own contracts, which sfo locks and
enforces.

## 2. The contracts

The project writes them and sfo runs them. They're declared by the stage
that scaffolds the toolchain (test-repair), locked with the tests, and
changeable only through the adjudicator.

`.sfo/CONTRACTS.json`:

```json
{
  "gate": [
    {"name": "install",   "run": ["npm", "ci"]},
    {"name": "lint",      "run": ["npm", "run", "lint"]},
    {"name": "typecheck", "run": ["npm", "run", "typecheck"]},
    {"name": "unit",      "run": ["npx", "vitest", "run"], "files": "tests/{slice}-*.test.ts"},
    {"name": "browser",   "run": ["npx", "playwright", "test"], "files": "tests/e2e/{slice}-*.spec.ts"}
  ],
  "install": {"run": ["npm", "link"], "check": [["tower", "--version"]]},
  "render":  [{"name": "home, desktop, dark", "run": ["npx", "playwright", "test", "render/home.spec.ts"], "produces": ["render/out/home-dark.png"]}],
  "smoke":   [{"name": "e-ink panel shows the forecast", "run": ["pio", "test", "-e", "magtag"],
               "needs": ["hardware: Adafruit MagTag on USB"], "effect": "reversible"}]
}
```

- **`gate`:** the commands, in order. A step with `files` is scoped: sfo puts
  the slice's own matching files on the end, with `{slice}` standing for the
  slice id as file names spell it (`s01`). Every command is an argument list
  and never runs through a shell, as today.
- **`install`:** how to put it where the person can use it (a PATH command, a
  browser extension folder, a flashed board), and how to check it worked.
- **`render`:** commands that produce something to *look at*, such as
  screenshots, terminal captures or photos of a board. Review views them and
  SUMMARY shows them. This takes the place of `PRESENTATION.json`'s capture
  logic.
- **`smoke`:** checks against the real thing. Each one carries its
  `effect`, and anything it `needs`.

**Worked examples, not code.** The test-repair prompt shows complete
contracts for a Python CLI, a Node CLI, a Vite web app and a PlatformIO board,
as examples to adapt. The two CLI recipes in `archetype.ts` become the first
two examples. There is no list of kinds: spec writes down what it's building,
in its own words.

## 3. Why a declared gate can be trusted: red, then green

An agent that writes its own gate could write a weak one (`echo ok`). Locking
stops later loosening. What stops a weak gate *at the start* is one generic
check:

- **Red, before the build.** Right after test-repair, sfo runs the gate
  against the unbuilt skeleton. The install, lint and typecheck steps must
  pass, and **every scoped step must fail** for every slice. A test step that
  passes on a skeleton isn't testing anything. That fails test-repair, and
  the check names the step.
- **Green, per slice.** As today: the slice's scoped steps must pass.
- **Every scoped step must actually run the slice's files.** If `files`
  matches nothing for a slice, the build refuses to start, as
  `slicesWithoutTests` does today.

This is what makes a project-declared gate about as trustworthy as one sfo
wrote itself, for kinds sfo will never anticipate.

## 4. Deferred checks: when the real thing isn't there

Some checks can't run unattended: a board that has to be plugged in, a phone
that has to be held, a person who has to look. A contract entry declares what
it `needs`. At run time:

- Anything a gate step `needs` makes the step **invalid**. The gate must be
  runnable anywhere, so test-repair is told to use host-side tests,
  simulators or fakes there.
- **A smoke or render entry whose needs aren't met is `deferred`,** not
  failed. It's reported as waiting on you, with what it needs.
- **Install can be deferred too,** for example flashing firmware onto a board
  that isn't connected. Deliver says what's needed.
- `sfo status` shows `done; 3 checks waiting for hardware → sfo check <id>`,
  and so does the notification.
- **`sfo check <id>`**, run when the hardware is there, runs the deferred
  entries: it asks you to confirm each need ("Is the MagTag connected over
  USB? [y/n]"), then runs them. Anything that fails gets the usual repair
  round, gated on everything that passed, and, if it fails again, the
  adjudicator. SUMMARY is updated.

Needs are free text. sfo doesn't try to detect hardware: you confirm it.

## 5. Preferences, as markdown

`~/.sfo/PREFERENCES.md` is the original spec's §14, as written:

```markdown
Web apps: Vite + React + TypeScript. Store data in the browser unless it needs to sync.
Python over Node for CLIs. No Tailwind.
Deliver locally; don't deploy anywhere unless I say so.
```

- It's included in the spec, plan and test-repair prompts as **guidance, not
  law**. When an idea needs something else (a list two people edit needs
  sync), spec deviates and records a `structural` decision saying why.
- `sfo preferences` opens it in `$EDITOR`. The eventual app's settings page
  edits the same file.
- The per-project snapshot stays in `ACCESS.json`, and model access stays
  structured, because sfo itself acts on that.

## 6. Clarify

- **What kind of thing:** the idea decides. If it could reasonably be more
  than one and doesn't say, that's a `blocking` question. There's no setting
  for it.
- **Checks needing hardware or a person:** spec lists them, and clarify tells
  the person up front which checks will wait for them, so a deferred check is
  never a surprise at delivery.

## 7. What changes in sfo

**Removed, or reduced to examples:**
- `RECIPES` and `SMOKE_RUNNERS` in `archetype.ts`
- the archetype allowlist
- `detectArchetype`'s sniffing
- the `cli-python`/`cli-node` branches in install and presentation

**Kept, and made generic:**
- the lock, which now covers `CONTRACTS.json`
- the per-slice gate, run from `gate`
- the passed-slice gate
- anti-gaming
- the smoke loop, run from `smoke`, with `needs` and deferral
- install and its check, run from `install`
- renders, run from `render`
- `SERVICES.jsonl`, which stays as the documented rules behind the strict
  fakes

`ARCHETYPE.json` stays as spec's free-text description of what it's
building. Existing projects without `CONTRACTS.json` get one generated from
their old archetype recipe, so shotname and ut-tower keep working.

**Sandbox:** write access for toolchain caches comes from the contract too
(`"writes": ["~/Library/Caches/ms-playwright"]`), up to a fixed maximum sfo
checks, instead of a list in the runner.

## 8. Build order

1. `CONTRACTS.json` schema, locking, and generating a contract for existing
   projects. The gate, install, render and smoke run from the contract, with
   no behaviour change for CLIs; every existing test still passes.
2. The red-then-green check after test-repair.
3. `needs`, deferral, and `sfo check`.
4. `PREFERENCES.md` and `sfo preferences`; prompts with worked examples,
   including web and a hardware board.
5. **One real web idea, end to end.** It proves "any kind" on the first kind
   that isn't a CLI, with no web code in sfo.
