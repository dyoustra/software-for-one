Read `.sfo/ARCHETYPE.json`, `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`,
`.sfo/SLICES.jsonl`, `.sfo/SERVICES.jsonl`, `.sfo/preferences.json`, `.sfo/SFO.md` (`.sfo/PREFERENCES.md` in older projects) if it exists,
and the test suite.

You do two things: make the toolchain exist, so the suite can load and fail
cleanly, and **declare how this project is verified**, in `.sfo/CONTRACTS.json`.
sfo runs exactly what you declare — for every slice, for the rest of the build —
and locks it with the tests, so no build agent can loosen it later.

## 1. The toolchain and the skeleton

Create whatever this project needs to be built and tested — the manifest, the
lockfile, compiler and linter config, test-runner config — following
`.sfo/ARCHETYPE.json`, `.sfo/SPEC.md` and the person's preferences. Install
what you declare, and run it.

Then run the suite. Every test is expected to **fail**: nothing is implemented
yet, and that is correct. Fix only the tests that **error** — an import that
cannot resolve, a symbol nothing defines, a syntax error, a fixture that raises
during setup — by creating the minimum skeleton: empty modules, stubs that
raise "not implemented", package files. Nothing that could make a test pass.

**Do not change what a test asserts.** If a test looks wrong, leave it: it is
the contract, and the build has to satisfy it.

## 2. `.sfo/CONTRACTS.json`

    {
      "gate":    [ {"name": "...", "run": ["argv", "..."], "files": "tests/{slice}-*.test.ts"} ],
      "install": {"run": ["argv"], "check": [["argv"]], "needs": []},
      "render":  [ {"name": "...", "run": ["argv"], "produces": ["path.png"], "needs": []} ],
      "smoke":   [ {"name": "<seam id from SERVICES.jsonl>", "run": ["argv"], "needs": []} ]
    }

- **`gate`** — the checks every slice must pass, in order: install, lint,
  typecheck, tests. A step with `files` runs one slice's tests: sfo puts that
  slice's matching files on the end of `run`. In the glob, `**` crosses
  directories, `*` does not, and `{slice}` stands for the slice id as file names
  spell it (`S-01` as `s01`). Every `run` is an argument list, run without a
  shell. **The gate must run anywhere, unattended**: no hardware, no person —
  use host-side tests, a simulator, or fakes. A gate step cannot declare `needs`.
- **`install`** — how to put it where the person uses it (a command on their
  PATH, an unpacked extension, firmware on a board), and `check` commands that
  prove it worked, each run from a new terminal.
- **`render`** — commands that produce something to look at: screenshots, a
  terminal capture, a photo. Review looks at what they produce.
- **`smoke`** — one entry per seam in `.sfo/SERVICES.jsonl` with a smoke check,
  `name` set to the seam's `id`, running that seam's smoke test for real.
- **`needs`** — on install, render or smoke only: what the check needs that an
  unattended run does not have, in plain words (`"hardware: Adafruit MagTag on
  USB"`). It is not run then; it waits for the person, who runs it later.

### What sfo checks before it locks this

- Install, lint and typecheck — every `gate` step without `files` — must pass
  against your skeleton. They run over the whole tree on every slice, so an
  error here would fail every slice for reasons that are not its own.
- **Every slice's scoped steps must fail against your skeleton.** Its tests
  cannot pass yet; if they do, the step is not running them. A gate that passes
  for every slice is refused as testing nothing.
- Every slice must have at least one file matching a scoped step's `files`.

Run all of it yourself before you finish.

## 3. Worked examples — adapt, do not copy blindly

**A Python CLI** (`pyproject.toml` with `[project.scripts]`, a `dev` dependency
group holding `pytest`, `ruff` and `mypy`, the package under `src/<name>/`, and
`[tool.mypy] exclude = ['^\.venv/', '^build/', '^dist/']` — mypy walks `.venv/`
otherwise):

    {"gate": [
       {"name": "install",   "run": ["uv", "sync"]},
       {"name": "lint",      "run": ["uv", "run", "ruff", "check", "."]},
       {"name": "typecheck", "run": ["uv", "run", "mypy", "--strict", "."]},
       {"name": "test",      "run": ["uv", "run", "pytest", "-q", "--ignore=smoke"], "files": "tests/**/*{slice}*"}],
     "install": {"run": ["uv", "tool", "install", "--editable", "--force", "."], "check": [["<command>", "--help"]]},
     "smoke": [{"name": "<seam>", "run": ["uv", "run", "pytest", "-q", "--noconftest", "smoke/test_smoke_<seam>.py"]}]}

**A Node CLI** (`package.json` with `"type": "module"` and `lint`, `typecheck`
and `test` scripts; run `npm install` and keep `package-lock.json`, which
`npm ci` requires):

    {"gate": [
       {"name": "install",   "run": ["npm", "ci"]},
       {"name": "lint",      "run": ["npm", "run", "lint"]},
       {"name": "typecheck", "run": ["npm", "run", "typecheck"]},
       {"name": "test",      "run": ["npx", "vitest", "run", "--exclude", "smoke/**"], "files": "tests/**/*{slice}*"}],
     "install": {"run": ["npm", "link"], "check": [["<command>", "--help"]]}}

**A web app** (Vite, React, TypeScript; unit tests in Vitest, browser tests in
Playwright against the production build — `playwright.config.ts` whose
`webServer` runs `vite build && vite preview --port $PORT`; install Chromium
with `npx playwright install chromium`):

    {"gate": [
       {"name": "install",   "run": ["npm", "ci"]},
       {"name": "lint",      "run": ["npm", "run", "lint"]},
       {"name": "typecheck", "run": ["npm", "run", "typecheck"]},
       {"name": "unit",      "run": ["npx", "vitest", "run"], "files": "tests/{slice}-*.test.ts"},
       {"name": "browser",   "run": ["npx", "playwright", "test"], "files": "tests/e2e/{slice}-*.spec.ts"}],
     "install": {"run": ["npm", "link"], "check": [["<launcher>", "--version"]]},
     "render": [{"name": "home, phone and desktop, light and dark",
                 "run": ["npx", "playwright", "test", "render/"],
                 "produces": ["render/out/home-desktop-light.png", "render/out/home-phone-dark.png"]}]}

The launcher in `bin` serves the production build on a free port and opens the
browser; `--version` must exit without starting it.

**Firmware for a board** (PlatformIO, with `test_dir = tests` in
`platformio.ini`; logic tested on the host in a `native` environment, so the
gate needs no board; flashing and the on-device check wait for the person):

    {"gate": [
       {"name": "build", "run": ["pio", "run", "-e", "magtag"]},
       {"name": "test",  "run": ["pio", "test", "-e", "native", "--filter"], "files": "tests/test_{slice}*"}],
     "install": {"run": ["pio", "run", "-e", "magtag", "-t", "upload"], "check": [],
                 "needs": ["hardware: Adafruit MagTag on USB"]},
     "smoke": [{"name": "magtag-display", "run": ["pio", "test", "-e", "magtag"],
                "needs": ["hardware: Adafruit MagTag on USB"]}]}

Whatever the toolchain's own convention, every test lives under `tests/` and
every smoke test under `smoke/` — configure the tool to look there. They are
what sfo locks.

When none of these fits, design the contract the same way: the gate is what
proves each slice works without anyone present; everything that needs the real
thing goes in `smoke` or `install`, with what it `needs`.

## Finish

When you are done the toolchain exists, `.sfo/CONTRACTS.json` is written, every
unscoped gate step passes, and every test fails rather than errors. If you
cannot reach that state, stop and say exactly what is blocking. Do not iterate;
report.

Write only the toolchain, its config, the lockfile, skeleton source files, and
`.sfo/CONTRACTS.json`. Do not modify anything else under `.sfo/`.
