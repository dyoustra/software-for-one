# House rules

Rules that apply to **every project sfo builds**, regardless of archetype. These
eventually become the `AGENTS.md` / `CLAUDE.md` that ships into each generated
project, per spec §12 and §14. Kept here until the archetype registry exists.

Each rule states the failure it prevents. A rule without a failure attached is a
preference, and preferences belong in the user preferences doc, not here.

---

## Money

**If the software spends the user's money, it must say how much before spending it.**

Any project that calls a paid API, provisions cloud resources, or bills per unit of
work must:

- estimate the cost of a job *before* starting it, from the actual input size;
- show that estimate in the dry-run/plan output, not bury it in a log;
- require explicit confirmation past a configurable threshold;
- report actual spend against the estimate when the job finishes.

*Prevents:* a user running a tool over 4,000 files and discovering the bill
afterwards. Cost is a first-class output, not an implementation detail — the same
reason `sfo` itself tracks per-stage spend in `COST.jsonl`.

## Destructive operations

**Dry-run is the default; the destructive path is opt-in and cannot be configured away.**

Anything that renames, deletes, overwrites, or mutates user data defaults to
showing what it *would* do. The apply flag is explicit, per-invocation, and has no
environment variable or config key that makes it the default.

*Prevents:* a config file or a stale shell alias silently turning a preview tool
into a destructive one.

## Reversibility

**If an operation cannot be undone, say so before doing it. If it can, provide the undo.**

Mutating operations write a journal mapping old state to new, and ship the command
that reverses it.

*Prevents:* the user's only recovery path being a backup they did not make.
