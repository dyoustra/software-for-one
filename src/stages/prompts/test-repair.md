Read `.sfo/ARCHETYPE.json`, `.sfo/CRITERIA.jsonl`, and the test suite.

**First, create the project manifest.** There is none yet, and without it the
suite cannot even be loaded: the test runner has nothing to install, and a
Python suite cannot import a package that has no project file. Every later
slice is verified by running the archetype's commands in this directory, so
all of them have to work here before you finish.

For `cli-python`, write `pyproject.toml` at the project root:

    [project]
    name = "<distribution name, matching the package the tests import>"
    version = "0.1.0"
    requires-python = ">=3.11"
    dependencies = ["<every third-party package the source will import>"]

    [project.scripts]
    <command-name> = "<import_name>.cli:main"

    [dependency-groups]
    dev = ["pytest", "ruff", "mypy"]

    [build-system]
    requires = ["hatchling"]
    build-backend = "hatchling.build"

    [tool.hatch.build.targets.wheel]
    packages = ["src/<import_name>"]

    [tool.mypy]
    exclude = ['^\.venv/', '^build/', '^dist/']

Put the skeleton under `src/<import_name>/` with an `__init__.py`, so the tests
import an installed package rather than whatever happens to be on `sys.path`.
`pytest`, `ruff` and `mypy` go in `dev` because the gate runs them through
`uv run` — a dependency the gate needs and the manifest does not declare is a
gate that cannot run at all. The `mypy` exclusions are not optional: the gate
runs `mypy --strict .` from the project root, and mypy walks `.venv/` unless
told not to.

For `cli-node`, write `package.json` at the project root with `"type":
"module"`, the dependencies the source will import, dev dependencies covering
`typescript`, `vitest` and the linter, and **all three** of these scripts, since
the gate invokes them by name:

    "scripts": { "lint": "...", "typecheck": "tsc --noEmit", "test": "vitest run" }

Then run `npm install` to generate `package-lock.json` and keep it: the gate
runs `npm ci`, which fails outright without a lockfile. Add `tsconfig.json` and
the linter's config alongside it.

Then verify the toolchain yourself, in the project root, before you finish:

- `cli-python`: `uv sync`, `uv run ruff check .`, `uv run mypy --strict .` must
  all exit 0, and `uv run pytest -q` must report failures rather than errors.
- `cli-node`: `npm ci`, `npm run lint`, `npm run typecheck` must all exit 0, and
  `npx vitest run` must report failures rather than errors.

Lint and typecheck run over the whole tree, tests included, and they run again
as part of every slice's gate. A skeleton that does not lint or type-check
cleanly now fails the first slice for reasons that have nothing to do with it,
and takes every dependent slice down with it. Annotate your stubs.

Then run the suite. Every test is expected to **fail** — nothing is
implemented yet, and that is correct. Your job is to fix only the tests that **error**:

- an import that cannot resolve
- a reference to a symbol nothing defines
- a syntax error
- a fixture that raises during setup

Create the minimum skeleton needed for the suite to load and fail cleanly: empty
modules, function stubs that raise `NotImplementedError`, package `__init__`
files. Nothing that could make a test pass.

**Do not change what a test asserts.** If a test errors because it imports
`shotname.plan`, create that module — do not delete the import. If a test looks
wrong to you, leave it: it is the contract, and the build stage will have to
satisfy it. Weakening a test here defeats the entire point of writing tests
before the implementation.

When you are done, the manifest must exist, the archetype's install, lint and
typecheck commands must pass, and every test must fail rather than error. If
you cannot reach that state — a missing dependency, a criterion you cannot
express as a loadable test — stop and say exactly what is blocking. Do not
iterate; report.

Write only the manifest, its toolchain config, the lockfile, and skeleton
source files. Do not modify anything under `.sfo/`.
