# Phase 2, Plan B — The Build Half

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a reviewed spec into working, verified software — slicing the criteria, writing tests before any code exists, building slice by slice, and delivering honestly when some slices fail.

**Architecture:** Tests are written first by an agent that never sees the implementation, which makes them the interface contract rather than a self-graded exercise. The pipeline slices the work so a crash costs one slice. Verification is objective and locked; review audits what the tests do not cover.

**Tech Stack:** Existing — TypeScript ESM, zod, commander, vitest. Generated projects use whatever the spec stage chose; the first archetype is `cli-python` (uv, Typer, pytest, ruff, mypy).

**Depends on Plan A**, which is complete: `CRITERIA.jsonl`, `DECISIONS.jsonl`, `QUESTIONS.json`, the prior-art gate, per-archetype ignores, and the criteria-drift warning are all in place and validated against a real project.

**Measured baseline this plan builds on** (screenshot renamer, 80 criteria in 12 groups): front half $9.39, criterion ids proven stable across a full-file rewrite, group sizes ranging 2–11 with a median of 9.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/core/slices.ts` | `SLICES.jsonl` schema, prerequisite ordering, skip-dependents logic. |
| `src/core/archetype.ts` | *(extend)* verify recipes per archetype, not just ignore patterns. |
| `src/core/testlock.ts` | Hashes test files after repair; `verify` refuses a changed test. |
| `src/core/budget.ts` | Per-project ceiling, checked against `COST.jsonl`. |
| `src/core/orchestrator.ts` | *(extend)* the slice loop. |
| `src/stages/prompts/{plan,test-write,test-repair,build,review,deliver}.md` | One per new stage. |
| `src/commands/slices.ts` | `sfo slices` renderer. |

---

## Task 1: Slice schema

**Files:**
- Create: `src/core/slices.ts`
- Test: `tests/core/slices.test.ts`

**Design note:** slices declare prerequisites, not a full dependency graph. Parallelism is moot with one build agent, and dependency-blocked delivery was ruled out in favour of plain partial delivery. What remains is cost: attempting `journal` after `collisions` failed burns a slice to fail again. Skipping also makes the summary honest.

- [ ] **Step 1: Write the failing test**

`tests/core/slices.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SliceSchema, readSlices, writeSlices, skippedBy, nextRunnable } from "../../src/core/slices.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-sl-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

const slices = [
  { id: "S-01", name: "Enumeration", criterionIds: ["AC-001", "AC-002"], prerequisites: [] },
  { id: "S-02", name: "Naming", criterionIds: ["AC-003"], prerequisites: ["S-01"] },
  { id: "S-03", name: "Collisions", criterionIds: ["AC-004"], prerequisites: ["S-02"] },
  { id: "S-04", name: "Sampling", criterionIds: ["AC-005"], prerequisites: [] },
];

describe("slices", () => {
  it("round-trips through disk", () => {
    writeSlices("p", slices, env);
    expect(readSlices("p", env)).toHaveLength(4);
  });

  it("rejects duplicate slice ids", () => {
    expect(() => writeSlices("p", [slices[0], { ...slices[1], id: "S-01" }], env)).toThrow(/duplicate/i);
  });

  it("rejects a prerequisite that names no known slice", () => {
    const orphan = [{ ...slices[0], prerequisites: ["S-99"] }];
    expect(() => writeSlices("p", orphan, env)).toThrow(/unknown prerequisite/i);
  });

  it("rejects a prerequisite cycle", () => {
    const cyclic = [
      { id: "S-01", name: "a", criterionIds: ["AC-001"], prerequisites: ["S-02"] },
      { id: "S-02", name: "b", criterionIds: ["AC-002"], prerequisites: ["S-01"] },
    ];
    expect(() => writeSlices("p", cyclic, env)).toThrow(/cycle/i);
  });

  it("rejects a slice with no criteria — nothing to build or verify", () => {
    expect(() => writeSlices("p", [{ ...slices[0], criterionIds: [] }], env)).toThrow(/no criteria/i);
  });

  it("skips everything downstream of a failed slice, transitively", () => {
    // S-02 depends on S-01, S-03 on S-02. Failing S-01 must skip both, not just
    // its direct dependent — otherwise S-03 burns a build to fail on missing code.
    expect(skippedBy(slices, ["S-01"]).sort()).toEqual(["S-02", "S-03"]);
  });

  it("leaves independent slices runnable when another fails", () => {
    expect(skippedBy(slices, ["S-01"])).not.toContain("S-04");
  });

  it("returns the next slice whose prerequisites have all passed", () => {
    expect(nextRunnable(slices, { passed: ["S-01"], failed: [] })?.id).toBe("S-02");
  });

  it("returns null when every slice is accounted for", () => {
    expect(nextRunnable(slices, { passed: ["S-01", "S-02", "S-03", "S-04"], failed: [] })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/slices.test.ts`
Expected: FAIL — cannot resolve `../../src/core/slices.js`

- [ ] **Step 3: Write the implementation**

`src/core/slices.ts`:

```typescript
import { z } from "zod";
import { artifactPath, type Env } from "./paths.js";
import { readRecords, writeRecords } from "./jsonl.js";

export const SliceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  criterionIds: z.array(z.string().min(1)).min(1),
  prerequisites: z.array(z.string()),
});

export type Slice = z.infer<typeof SliceSchema>;
export const SLICES_FILE = "SLICES.jsonl";

function validate(slices: Slice[]): void {
  const ids = new Set<string>();
  for (const s of slices) {
    if (ids.has(s.id)) throw new Error(`duplicate slice id: ${s.id}`);
    if (s.criterionIds.length === 0) throw new Error(`slice ${s.id} has no criteria`);
    ids.add(s.id);
  }
  for (const s of slices) {
    for (const p of s.prerequisites) {
      if (!ids.has(p)) throw new Error(`slice ${s.id} has unknown prerequisite ${p}`);
    }
  }

  // A cycle would make nextRunnable loop forever with nothing runnable, which
  // reads as a stalled build rather than a malformed plan.
  const state = new Map<string, "visiting" | "done">();
  const byId = new Map(slices.map((s) => [s.id, s]));
  const walk = (id: string, trail: string[]): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      throw new Error(`prerequisite cycle: ${[...trail, id].join(" -> ")}`);
    }
    state.set(id, "visiting");
    for (const p of byId.get(id)?.prerequisites ?? []) walk(p, [...trail, id]);
    state.set(id, "done");
  };
  for (const s of slices) walk(s.id, []);
}

export function readSlices(id: string, env?: Env): Slice[] {
  return readRecords(artifactPath(id, SLICES_FILE, env), SliceSchema);
}

export function writeSlices(id: string, slices: Slice[], env?: Env): void {
  validate(slices);
  writeRecords(artifactPath(id, SLICES_FILE, env), SliceSchema, slices);
}

/** Transitive dependents of any failed slice — these must not be attempted. */
export function skippedBy(slices: Slice[], failed: string[]): string[] {
  const dead = new Set(failed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of slices) {
      if (dead.has(s.id)) continue;
      if (s.prerequisites.some((p) => dead.has(p))) {
        dead.add(s.id);
        grew = true;
      }
    }
  }
  for (const f of failed) dead.delete(f);
  return [...dead];
}

export function nextRunnable(
  slices: Slice[],
  progress: { passed: string[]; failed: string[] },
): Slice | null {
  const passed = new Set(progress.passed);
  const unavailable = new Set([...progress.failed, ...skippedBy(slices, progress.failed)]);

  for (const s of slices) {
    if (passed.has(s.id) || unavailable.has(s.id)) continue;
    if (s.prerequisites.every((p) => passed.has(p))) return s;
  }
  return null;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/slices.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: slice schema with prerequisites and transitive skip"
```

---

## Task 2: Verify recipes in the archetype registry

**Files:**
- Modify: `src/core/archetype.ts`
- Test: update `tests/core/archetype.test.ts`

**Design note:** the registry does not dictate the stack — the spec stage picks it, and picked Python for a better reason than any default would have. The registry supplies the **verify recipe** for a chosen stack. Where it has none, verification degrades to what it can run and the summary says which gates did not run. Never a silent downgrade.

- [ ] **Step 1: Write the failing test**

Append to `tests/core/archetype.test.ts`:

```typescript
import { verifyRecipeFor, type VerifyStep } from "../../src/core/archetype.js";

describe("verifyRecipeFor", () => {
  it("supplies install, lint, typecheck and test for cli-python", () => {
    const names = verifyRecipeFor("cli-python").map((s: VerifyStep) => s.name);
    expect(names).toContain("install");
    expect(names).toContain("lint");
    expect(names).toContain("typecheck");
    expect(names).toContain("test");
  });

  it("returns an empty recipe for an unknown archetype rather than guessing", () => {
    // A wrong command reported as a passing gate is worse than an honest gap.
    expect(verifyRecipeFor("cobol-mainframe")).toEqual([]);
  });

  it("marks the test step so the runner can scope it to one slice", () => {
    const test = verifyRecipeFor("cli-python").find((s: VerifyStep) => s.name === "test");
    expect(test?.scopeable).toBe(true);
  });

  it("gives every step a command and args, never a shell string", () => {
    // execFile with an args array, never a shell — a criterion or path with a
    // quote in it must not become a shell injection.
    for (const step of verifyRecipeFor("cli-python")) {
      expect(typeof step.command).toBe("string");
      expect(Array.isArray(step.args)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/archetype.test.ts`
Expected: FAIL — `verifyRecipeFor` is not exported

- [ ] **Step 3: Write the implementation**

Append to `src/core/archetype.ts`:

```typescript
export interface VerifyStep {
  name: string;
  command: string;
  args: string[];
  /** Whether the runner may append a path to scope this step to one slice. */
  scopeable: boolean;
}

/**
 * Commands are `{command, args[]}` rather than shell strings, so they run via
 * execFile with no shell. Criterion text and paths reach these commands, and a
 * quote or a semicolon in a filename must not become an injection.
 */
const RECIPES: Record<string, VerifyStep[]> = {
  "cli-python": [
    { name: "install", command: "uv", args: ["sync"], scopeable: false },
    { name: "lint", command: "uv", args: ["run", "ruff", "check", "."], scopeable: false },
    { name: "typecheck", command: "uv", args: ["run", "mypy", "--strict", "."], scopeable: false },
    { name: "test", command: "uv", args: ["run", "pytest", "-q"], scopeable: true },
  ],
  "cli-node": [
    { name: "install", command: "npm", args: ["ci"], scopeable: false },
    { name: "lint", command: "npm", args: ["run", "lint"], scopeable: false },
    { name: "typecheck", command: "npm", args: ["run", "typecheck"], scopeable: false },
    { name: "test", command: "npx", args: ["vitest", "run"], scopeable: true },
  ],
};

/**
 * An unknown archetype gets NO recipe, deliberately — the opposite of the
 * gitignore fallback. There, guessing wide costs an ignored file; here, a
 * guessed command that happens to exit 0 reports a passing gate for checks
 * that never ran. An honest gap beats a false green.
 */
export function verifyRecipeFor(archetype: string): VerifyStep[] {
  return RECIPES[archetype] ?? [];
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/archetype.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: verify recipes per archetype, empty rather than guessed"
```

---

## Task 3: Test lock

**Files:**
- Create: `src/core/testlock.ts`
- Test: `tests/core/testlock.test.ts`

**Design note:** "tests are locked" must be enforced, not requested. A prompt saying *do not modify the tests* is exactly the instruction an agent under pressure reinterprets, and this session produced repeated evidence that prompt instructions are followed unevenly. `verify` hashes every test file after `test-repair` and re-checks; a changed file fails the gate outright even if the suite passes.

- [ ] **Step 1: Write the failing test**

`tests/core/testlock.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lockTests, verifyTestLock, readTestLock } from "../../src/core/testlock.js";

let env: Record<string, string>;
let dir: string;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-lock-")) };
  dir = path.join(env.SFO_HOME, "p");
  fs.mkdirSync(path.join(dir, ".sfo"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests", "test_a.py"), "def test_a(): assert True\n");
  fs.writeFileSync(path.join(dir, "tests", "test_b.py"), "def test_b(): assert True\n");
});

describe("testlock", () => {
  it("records a hash per test file", () => {
    lockTests("p", "tests", env);
    expect(Object.keys(readTestLock("p", env))).toHaveLength(2);
  });

  it("passes when nothing changed", () => {
    lockTests("p", "tests", env);
    expect(verifyTestLock("p", "tests", env)).toEqual([]);
  });

  it("reports a modified test file", () => {
    lockTests("p", "tests", env);
    fs.writeFileSync(path.join(dir, "tests", "test_a.py"), "def test_a(): assert False\n");
    expect(verifyTestLock("p", "tests", env)).toEqual(["tests/test_a.py"]);
  });

  it("reports a deleted test file", () => {
    // Deleting a test is the cheapest way to make a suite pass.
    lockTests("p", "tests", env);
    fs.rmSync(path.join(dir, "tests", "test_b.py"));
    expect(verifyTestLock("p", "tests", env)).toEqual(["tests/test_b.py"]);
  });

  it("reports a test file added after the lock", () => {
    // A new file is not tampering, but it is untested territory claiming to be
    // tested — the lock is the record of what was agreed.
    lockTests("p", "tests", env);
    fs.writeFileSync(path.join(dir, "tests", "test_c.py"), "def test_c(): assert True\n");
    expect(verifyTestLock("p", "tests", env)).toEqual(["tests/test_c.py"]);
  });

  it("passes trivially when no lock exists yet", () => {
    expect(verifyTestLock("p", "tests", env)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/testlock.test.ts`
Expected: FAIL — cannot resolve `../../src/core/testlock.js`

- [ ] **Step 3: Write the implementation**

`src/core/testlock.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { artifactPath, projectDir, sfoDir, type Env } from "./paths.js";

export const TEST_LOCK_FILE = "TESTS.lock.json";
export type TestLock = Record<string, string>;

function walk(root: string, base = ""): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(root, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

function hashTree(dir: string, testDir: string): TestLock {
  const root = path.join(dir, testDir);
  const lock: TestLock = {};
  for (const rel of walk(root)) {
    const body = fs.readFileSync(path.join(root, rel));
    lock[`${testDir}/${rel}`] = createHash("sha256").update(body).digest("hex");
  }
  return lock;
}

export function lockTests(id: string, testDir: string, env?: Env): void {
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(
    artifactPath(id, TEST_LOCK_FILE, env),
    `${JSON.stringify(hashTree(projectDir(id, env), testDir), null, 2)}\n`,
  );
}

export function readTestLock(id: string, env?: Env): TestLock {
  const file = artifactPath(id, TEST_LOCK_FILE, env);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as TestLock) : {};
}

/**
 * Paths that differ from the lock: modified, deleted, or added. Empty means the
 * suite the build is being graded against is the one that was agreed.
 */
export function verifyTestLock(id: string, testDir: string, env?: Env): string[] {
  const locked = readTestLock(id, env);
  if (Object.keys(locked).length === 0) return [];

  const current = hashTree(projectDir(id, env), testDir);
  const paths = new Set([...Object.keys(locked), ...Object.keys(current)]);
  return [...paths].filter((p) => locked[p] !== current[p]).sort();
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/testlock.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: hash-based test lock so the gate cannot be negotiated with"
```

---

## Task 4: Budget ceiling

**Files:**
- Create: `src/core/budget.ts`
- Modify: `src/commands/new.ts`, `src/cli.ts`
- Test: `tests/core/budget.test.ts`

**Design note:** this is a deliberate exception to *never block on something you could decide yourself*. Money is the case where the pipeline genuinely cannot decide — it is the user's, and being wrong in either direction is bad. Hitting the ceiling parks the project rather than aborting, so the user chooses between raising it and taking the partial delivery.

- [ ] **Step 1: Write the failing test**

`tests/core/budget.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBudget, writeBudget, budgetState } from "../../src/core/budget.js";
import { recordCost } from "../../src/core/cost.js";

let env: Record<string, string>;

const usage = {
  costUsd: 4, durationMs: 1000, numTurns: 1,
  inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
};

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-bud-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

describe("budget", () => {
  it("returns null when no ceiling is set", () => {
    expect(readBudget("p", env)).toBeNull();
  });

  it("round-trips a ceiling", () => {
    writeBudget("p", 25, env);
    expect(readBudget("p", env)).toBe(25);
  });

  it("rejects a non-positive ceiling", () => {
    expect(() => writeBudget("p", 0, env)).toThrow(/positive/i);
  });

  it("reports remaining spend against actual cost", () => {
    writeBudget("p", 10, env);
    recordCost("p", "research", true, usage, env);
    const state = budgetState("p", env);
    expect(state?.spent).toBe(4);
    expect(state?.remaining).toBe(6);
    expect(state?.exceeded).toBe(false);
  });

  it("reports exceeded once spend reaches the ceiling", () => {
    writeBudget("p", 7, env);
    recordCost("p", "research", true, usage, env);
    recordCost("p", "spec", true, usage, env);
    expect(budgetState("p", env)?.exceeded).toBe(true);
  });

  it("counts failed stages against the budget", () => {
    // A failed stage spent real money. Excluding it would let a project with
    // repeated failures run past its ceiling indefinitely.
    writeBudget("p", 7, env);
    recordCost("p", "research", false, usage, env);
    recordCost("p", "research", true, usage, env);
    expect(budgetState("p", env)?.exceeded).toBe(true);
  });

  it("returns null state when no ceiling is set, whatever the spend", () => {
    recordCost("p", "research", true, usage, env);
    expect(budgetState("p", env)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/budget.test.ts`
Expected: FAIL — cannot resolve `../../src/core/budget.js`

- [ ] **Step 3: Write the implementation**

`src/core/budget.ts`:

```typescript
import fs from "node:fs";
import { artifactPath, sfoDir, type Env } from "./paths.js";
import { readCostRecords } from "./cost.js";

export const BUDGET_FILE = "BUDGET.json";

export interface BudgetState {
  ceiling: number;
  spent: number;
  remaining: number;
  exceeded: boolean;
}

export function readBudget(id: string, env?: Env): number | null {
  const file = artifactPath(id, BUDGET_FILE, env);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { ceilingUsd?: unknown };
  return typeof parsed.ceilingUsd === "number" ? parsed.ceilingUsd : null;
}

export function writeBudget(id: string, ceilingUsd: number, env?: Env): void {
  if (!(ceilingUsd > 0)) throw new Error("budget ceiling must be positive");
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(
    artifactPath(id, BUDGET_FILE, env),
    `${JSON.stringify({ ceilingUsd }, null, 2)}\n`,
  );
}

/**
 * Spend counts every recorded run, including failed ones. A failed stage spent
 * real money; excluding it would let a project with repeated failures run past
 * its ceiling indefinitely — the exact case a ceiling exists for.
 */
export function budgetState(id: string, env?: Env): BudgetState | null {
  const ceiling = readBudget(id, env);
  if (ceiling === null) return null;

  const spent = readCostRecords(id, env).reduce((sum, r) => sum + r.usage.costUsd, 0);
  return { ceiling, spent, remaining: ceiling - spent, exceeded: spent >= ceiling };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/budget.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Wire a `--budget` flag onto `sfo new`, and surface it in `sfo cost`**

Add `--budget <usd>` to the `new` command; when given, call `writeBudget` after `createProject`. In `src/commands/cost.ts`, append a line showing ceiling and remaining when a budget exists.

- [ ] **Step 6: Verify and commit**

Run: `npm test && npm run build && npm run typecheck`

```bash
git add -A && git commit -m "feat: per-project budget ceiling counted against actual spend"
```

---

## Task 5: The plan stage

**Files:**
- Create: `src/stages/prompts/plan.md`
- Create: `src/commands/slices.ts`
- Modify: `src/core/stages.ts`, `src/cli.ts`
- Test: `tests/commands/slices.test.ts`

**Design note:** `plan` **refines** the spec stage's grouping rather than inventing one. The spec clusters criteria while holding the research and the whole design in context — more than `plan` will ever have. Measured on the real project: 12 groups, sizes 2–11, median 9.

- [ ] **Step 1: Write the prompt**

`src/stages/prompts/plan.md`:

```markdown
Read `.sfo/SPEC.md` and `.sfo/CRITERIA.jsonl`.

Group the criteria into build slices and write `.sfo/SLICES.jsonl`, one JSON
object per line:

    {"id":"S-01","name":"Enumeration and file identification","criterionIds":["AC-001","AC-002"],"prerequisites":[]}

**Start from the `group` field already on each criterion.** The spec stage
clustered them while holding the full design in context; your job is to refine
that grouping, not replace it.

Refine it by these rules:

- **Merge groups smaller than about four criteria** into the most closely
  related neighbour. Each slice costs a fixed amount to run regardless of size,
  so a two-criterion slice is mostly overhead.
- **Split groups larger than about twelve** along a natural seam. A slice should
  be a tractable unit of work, not a wall of failing tests.
- Aim for five to ten criteria per slice.
- Every criterion must appear in exactly one slice. None may be dropped.

Set `prerequisites` to the slices that must be working first — naming needs
enumeration, collision handling needs naming. Keep these minimal and real: a
prerequisite that is not genuinely required only serialises work and widens the
blast radius when something fails, because a failed slice skips everything
downstream of it. Leave `prerequisites` empty for anything independent.

Order the slices so that a person building this by hand would work in that
order.

Also write `.sfo/PLAN.md`: a short prose summary of the build order and why the
slices are cut where they are. It is for a human deciding whether the plan is
sane before committing to the build.

Write only `.sfo/SLICES.jsonl` and `.sfo/PLAN.md`.
```

- [ ] **Step 2: Add `plan` to the stage sequence**

In `src/core/stages.ts`, extend `PHASE_1_STAGES` into the full sequence, renaming it `PIPELINE_STAGES`, and add `plan` after `clarify`. Keep `blocksOnHuman` as-is. Update every import.

- [ ] **Step 3: Write the slices renderer**

`src/commands/slices.ts` — a pure `formatSlices(slices, criteria)` showing each slice with its criterion count and prerequisites, plus a `sfo slices <id>` command wrapped in `guarded(...)`. Test that a slice with prerequisites renders them, and that an empty set reports cleanly.

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm run build && npm run typecheck`

```bash
git add -A && git commit -m "feat: plan stage refines the spec's grouping into build slices"
```

---

## Task 6: The test-write stage

**Files:**
- Create: `src/stages/prompts/test-write.md`
- Modify: `src/core/stages.ts`

**Design note:** this is the load-bearing decision of Phase 2. Tests are written from the criteria with **no implementation in existence**, by an agent that never sees one. That makes them the interface contract — the build stage must satisfy a target it did not set — and removes the fox-guarding-henhouse problem rather than policing it.

- [ ] **Step 1: Write the prompt**

`src/stages/prompts/test-write.md`:

```markdown
Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, and `.sfo/SLICES.jsonl`.

Write the test suite. **No implementation exists yet, and you must not write
any.** You are writing the contract the implementation will have to satisfy.

**One test file per slice**, named for the slice id and name — for a Python
project, `tests/test_s01_enumeration.py`. The build stage runs one slice at a
time and scopes the test run to that slice's file, so this mapping is what makes
slicing work.

Every criterion in a slice gets at least one test. Name each test so the
criterion it covers is obvious, and put the criterion id in the test's docstring
or a comment. A criterion with no test is a hole in the contract that the review
stage will find.

**You are designing the interface.** When you write `from shotname.plan import
plan_renames`, you are deciding that module and that signature exist. Choose
names and shapes a competent developer would choose, keep the surface small, and
be consistent across slices — the build stage has to produce exactly what you
import.

Build any fixtures the criteria imply. `.sfo/SPEC.md` may already describe the
fixture corpus it expects; if so, build that. Fixtures are code and go in the
test tree.

**These tests are expected to fail.** Nothing implements them yet. A failing
test means the code is missing, which is correct. What must NOT happen is a test
that *errors* — an import that cannot resolve a module you never create, a
reference to a symbol nothing defines, a syntax error. Write tests that fail
cleanly against a skeleton.

Write only files under the test tree. Do not create source modules, do not write
a skeleton, do not modify anything under `.sfo/`.
```

- [ ] **Step 2: Add `test-write` to the stage sequence, after `plan`**

- [ ] **Step 3: Verify and commit**

```bash
git add -A && git commit -m "feat: test-write stage authors the contract before any code exists"
```

---

## Task 7: The test-repair stage

**Files:**
- Create: `src/stages/prompts/test-repair.md`
- Modify: `src/core/orchestrator.ts` (lock the tests after this stage)

**Design note:** a correct test-first suite **fails**; a broken one **errors**. That distinction is mechanical and needs no model judgment. One pass, then a hard termination check — no iteration, which would invite oscillation between competing fixes. After it passes, `lockTests` records the hashes and the suite is frozen.

- [ ] **Step 1: Write the prompt**

`src/stages/prompts/test-repair.md`:

```markdown
Read `.sfo/CRITERIA.jsonl` and the test suite.

Run the suite. Every test is expected to **fail** — nothing is implemented yet,
and that is correct. Your job is to fix only the tests that **error**:

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

When you are done, every test must fail rather than error. If you cannot reach
that state — a missing dependency, a criterion you cannot express as a loadable
test — stop and say exactly what is blocking. Do not iterate; report.

Write only skeleton source files. Do not modify anything under `.sfo/`.
```

- [ ] **Step 2: Lock the tests after the stage succeeds**

In the orchestrator, after a successful `test-repair`, call `lockTests(id, testDir, env)`. The test directory comes from the archetype; default `tests`.

- [ ] **Step 3: Add a test** asserting the lock file exists after test-repair and that a subsequent modification is detected by `verifyTestLock`.

- [ ] **Step 4: Verify and commit**

```bash
git add -A && git commit -m "feat: test-repair fixes errors only, then freezes the suite"
```

---

## Task 8: Sliced build and verify

**Files:**
- Create: `src/stages/prompts/build.md`
- Create: `src/core/verify.ts`
- Modify: `src/core/orchestrator.ts`
- Test: `tests/core/verify.test.ts`

**Design note:** the pipeline slices the work so a crash costs one slice. The first real run lost a 336-second, $1.25, 24-turn stage to a dropped VPN and wrote nothing — that is the evidence. Each passing slice commits.

- [ ] **Step 1: Write `src/core/verify.ts`**

Runs the archetype's recipe with `execFile` (never a shell), returns per-step results, and **fails the gate outright if `verifyTestLock` reports anything** — before even running the suite, since a modified test makes a green suite meaningless. Scope the `test` step to the current slice's file when `scopeable`.

Test at minimum: a passing recipe reports every step; a failing step short-circuits the rest; a tampered test file fails the gate before the suite runs; an empty recipe reports "no gates available" rather than success.

- [ ] **Step 2: Write the build prompt**

`src/stages/prompts/build.md`:

```markdown
Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, `.sfo/SLICES.jsonl`, and
`.sfo/DECISIONS.jsonl`.

You are building **one slice**, named in your instructions. Make its tests pass.

- The tests are the contract. **You may not modify, delete, or skip any test.**
  They are hash-locked and a change fails the gate regardless of whether the
  suite passes.
- Slices whose prerequisites you depend on are already built and passing. Use
  what exists rather than reimplementing it.
- Do not build for slices other than yours. Another slice's failing tests are
  not your problem.
- Follow the stack and conventions in `.sfo/SPEC.md`. Where it named a library,
  use that library.

**Write as you go.** Save working code as you complete each piece rather than
holding everything until the end — a stage killed midway must leave usable work
behind.

Format your own output before you finish, using the project's formatter. The
verification gate checks whether the code is correct, not whether it is tidy —
so tidiness is your job, and nothing downstream will fix it for you.

When you make a choice the spec did not settle, append it to
`.sfo/DECISIONS.jsonl` with `"decided_by":"agent"` and an honest
`blast_radius`. `local` means one slice would be rebuilt; `structural` means
most of the project; `external` means a side effect outside this repo that
cannot be undone.

Do not write to `.sfo/` other than appending decisions. Do not modify the test
tree.
```

- [ ] **Step 3: Persist slice progress in state**

Add to `ProjectStateSchema` in `src/core/state.ts`. `.default([])` keeps every existing `state.json` parseable — a project mid-Phase-1 has no slice fields and must not become unreadable.

```typescript
  slicesPassed: z.array(z.string()).default([]),
  slicesFailed: z.array(z.string()).default([]),
```

- [ ] **Step 4: Extend the orchestrator with the slice loop**

The loop persists after every slice, so a killed run resumes at the next one rather than rebuilding what already passed. That is the whole reason the pipeline slices rather than letting one agent manage 80 tests.

```typescript
async function runSlices(
  id: string,
  runner: Runner,
  env: Env | undefined,
  archetype: string,
): Promise<void> {
  const slices = readSlices(id, env);
  const criteria = readCriteria(id, env);

  while (true) {
    let state = readState(id, env);
    const slice = nextRunnable(slices, {
      passed: state.slicesPassed,
      failed: state.slicesFailed,
    });
    if (!slice) return;

    // Checked before spending, not after. A ceiling discovered post-hoc is a
    // report, not a limit.
    const budget = budgetState(id, env);
    if (budget?.exceeded) {
      writeState(
        { ...state, status: "awaiting_human", pid: null, updatedAt: new Date().toISOString() },
        env,
      );
      return;
    }

    const stageName = `build-${slice.id}`;
    const result = await runner.runStage({
      workdir: projectDir(id, env),
      prompt: buildPromptFor(slice, criteria),
      logPath: logPath(id, stageName, env),
    });
    recordCost(id, stageName, result.ok, result.usage, env);

    const verdict = result.ok
      ? runVerify(id, archetype, slice, env)
      : { ok: false, steps: [], tamperedTests: [] };

    state = readState(id, env);
    if (verdict.ok) {
      writeState(
        { ...state, slicesPassed: [...state.slicesPassed, slice.id], updatedAt: new Date().toISOString() },
        env,
      );
      commitStage(id, stageName, env);
      continue;
    }

    const attempts = (state.attempts[slice.id] ?? 0) + 1;
    writeState(
      {
        ...state,
        attempts: { ...state.attempts, [slice.id]: attempts },
        // Two attempts, then give up on this slice and everything downstream.
        // A third attempt is where an agent starts weakening what it cannot fix.
        slicesFailed: attempts >= 2 ? [...state.slicesFailed, slice.id] : state.slicesFailed,
        updatedAt: new Date().toISOString(),
      },
      env,
    );
  }
}
```

- [ ] **Step 5: Give the build agent its slice**

`loadPrompt("build")` returns static text; the agent needs to know *which* slice. Append the slice's criteria to the prompt rather than expecting it to infer them:

```typescript
function buildPromptFor(slice: Slice, criteria: Criterion[]): string {
  const mine = criteria.filter((c) => slice.criterionIds.includes(c.id));
  const lines = mine.map((c) => `- ${c.id}: ${c.text}`);
  return [
    loadPrompt("build"),
    "",
    `## Your slice: ${slice.id} — ${slice.name}`,
    "",
    "Make exactly these criteria pass:",
    "",
    ...lines,
  ].join("\n");
}
```

- [ ] **Step 6: Test the loop**

With a fake runner: a passing slice records in `slicesPassed` and commits; a slice failing twice lands in `slicesFailed`; its dependents are never attempted; an independent slice still runs; a run resumed after a kill starts at the next unbuilt slice rather than the first.

- [ ] **Step 7: Verify and commit**

```bash
git add -A && git commit -m "feat: sliced build and verify with a locked test suite"
```

---

## Task 9: Review and deliver

**Files:**
- Create: `src/stages/prompts/review.md`, `src/stages/prompts/deliver.md`
- Modify: `src/core/stages.ts`

**Design note:** with tests written blind from the criteria, re-checking code against criteria is largely redundant. The gap tests **cannot** see is the requirement that never became a test. So review reads `SPEC.md` against the **test suite**, not the code — cheaper, and pointed at a different failure mode.

- [ ] **Step 1: Write the review prompt**

`src/stages/prompts/review.md`:

```markdown
Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, and the test suite.

You are auditing **coverage**, not correctness. The suite already checks that
the code does what the criteria say; your job is to find what nothing checks.

Look for:

- **Spec requirements with no criterion.** Something `SPEC.md` states as
  required that never became an acceptance criterion.
- **Criteria with no test.** A criterion id that appears in no test file.
- **Tests weaker than their criterion.** A criterion saying "at most 255 bytes
  when UTF-8 encoded" tested only with ASCII input; a determinism criterion
  tested with a single run.

Write `.sfo/REVIEW.md`: findings with severity, each naming the criterion or
spec section and what is missing. Say plainly if you find nothing — an audit
that manufactures findings to look useful is worse than one that reports a clean
result.

Do not modify tests or code. You are reading, not fixing.
```

- [ ] **Step 2: Write the deliver prompt**

`src/stages/prompts/deliver.md`:

```markdown
Read `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, `.sfo/SLICES.jsonl`,
`.sfo/REVIEW.md`, `.sfo/DECISIONS.jsonl`, and the verify results.

Write `.sfo/SUMMARY.md`.

**Lead with what does not work.** If any slice failed or was skipped, that is
the first thing in the document — which criteria are unmet, and what the person
cannot do as a result. Burying a gap under a list of what worked is the failure
this whole pipeline exists to prevent.

Then, in order:

1. **What this is and how to run it** — the actual commands, assuming nothing.
2. **What was not verified** — any gate the archetype had no recipe for, stated
   plainly rather than omitted.
3. **Decisions worth reviewing** — pull from `.sfo/DECISIONS.jsonl`, `external`
   and `structural` first. These are the calls that are expensive to reverse and
   the ones most worth a human's attention.
4. **Coverage gaps** from `.sfo/REVIEW.md`.

Be accurate rather than reassuring. Someone reads this to decide whether to
trust the thing you built.

Write only `.sfo/SUMMARY.md`.
```

- [ ] **Step 3: Add `review` and `deliver` to the stage sequence and verify**

```bash
git add -A && git commit -m "feat: review audits coverage; deliver leads with the gap"
```

---

## Task 10: Precise post-plan estimate

**Files:**
- Modify: `src/stages/prompts/plan.md`, `src/core/orchestrator.ts`

The `plan` stage knows the stack, criterion count and slice count, so its estimate can be held to accuracy in a way the rough one cannot. Have `plan` also write an `ESTIMATE.jsonl` record with `phase: "build"`, and have the orchestrator park the project as `awaiting_human` if that estimate exceeds the budget ceiling — the same pause-and-choose path a mid-build ceiling hit uses.

- [ ] Add the estimate instruction to `plan.md`, with the measured front-half numbers as calibration.
- [ ] Gate on it in the orchestrator, reusing the budget park path.
- [ ] Test that a plan estimate over the ceiling parks the project before any build spend.
- [ ] Commit.

---

## Task 11: End-to-end build run

**Files:**
- Modify: `docs/RUNBOOK.md`

The screenshot renamer has 80 criteria in 12 groups and a settled spec. Run it.

- [ ] **Step 1:** `sfo run <id>` through `plan`, and read `PLAN.md` and `sfo slices <id>` before letting it build. **Check the slicing by hand** — this is the first evidence about slice size, and the plan stage merging the two 2-criterion groups is the specific thing to confirm.
- [ ] **Step 2:** Let `test-write` and `test-repair` run. Inspect the suite: does every criterion have a test? Do the tests fail rather than error?
- [ ] **Step 3:** Let the build run slice by slice. Watch cost per slice in `sfo cost`.
- [ ] **Step 4:** Read `SUMMARY.md`. Does it lead with what does not work?
- [ ] **Step 5:** Record in the runbook: cost per slice, slices passed and failed, whether review found a genuine coverage gap, and whether the built tool actually runs.

## Definition of done

- [ ] `npm test` green, build and typecheck clean
- [ ] The screenshot renamer builds and passes its own generated suite
- [ ] A tampered test fails the gate even when the suite passes
- [ ] A killed build resumes at the next slice rather than restarting
- [ ] `SUMMARY.md` leads with unmet criteria when a slice fails
- [ ] `review` finds a genuine coverage gap, or is demonstrated redundant and cut
- [ ] `sfo cost` attributes spend per slice

## Deferred to Phase 3

Test-change adjudicator (build on evidence of need) · `ambiguity_policy` blocking modes · second archetype · deploy-to-URL · follow-up/brownfield requests · Expo client · cloud runner · sandboxing · accounts and BYO key · database · second runner.
