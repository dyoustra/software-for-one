import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifyRecipeFor, type VerifyStep } from "./archetype.js";
import { readStack } from "./stack.js";
import { verifyTestLock, readTestLock } from "./testlock.js";
import { projectDir, type Env } from "./paths.js";
import type { Slice } from "./slices.js";

/**
 * The tree the suite lives in. Not yet a property of the archetype: neither
 * registered archetype puts tests anywhere else, and the test-write prompt
 * names `tests/` outright. It is a constant here so the lock, the gate and the
 * prompt cannot drift apart — three places guessing separately is how a gate
 * ends up verifying a directory nobody writes to.
 */
export const TEST_DIR = "tests";

/** A stuck command must not hold a project open forever. */
const STEP_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface VerifyStepResult {
  name: string;
  ok: boolean;
  /** null when the command could not be started at all — a missing tool. */
  exitCode: number | null;
  output: string;
}

export interface VerifyResult {
  ok: boolean;
  /** Steps actually run, in order. Short of the recipe when one failed. */
  steps: VerifyStepResult[];
  /** Test paths that no longer match the lock. Non-empty means no step ran. */
  tamperedTests: string[];
  /** Why the gate failed, when no step reports it. */
  reason?: string;
}

/**
 * The archetype this project is graded as.
 *
 * The recorded choice wins. The spec stage picks the stack and writes it to
 * `.sfo/ARCHETYPE.json`, and what the deciding stage wrote down beats anything
 * inferred after the fact — sniffing cannot tell a Python project whose
 * manifest has not been created yet from one that is not Python at all.
 *
 * Sniffing survives as the fallback for projects created before the record
 * existed, and because a manifest describes what the project actually became
 * rather than what was planned. An unrecognised project falls through to
 * "unknown", which has no recipe — the gate then reports that it verified
 * nothing instead of passing.
 *
 * Throws when the record exists but is malformed or names an archetype the
 * registry does not know. Falling back to sniffing there would quietly grade
 * the project as something nobody chose.
 */
export function detectArchetype(id: string, env?: Env): string {
  const recorded = readStack(id, env);
  if (recorded) return recorded.archetype;

  const dir = projectDir(id, env);
  if (fs.existsSync(path.join(dir, "pyproject.toml"))) return "cli-python";
  if (fs.existsSync(path.join(dir, "package.json"))) return "cli-node";
  return "unknown";
}

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

/**
 * Matches a slice id against a test filename: `S-01` finds `test_s01_names.py`
 * and `test-s01.spec.ts`, because test-write is told to name one file per slice
 * after the slice.
 *
 * The trailing `(?![0-9])` is the part that matters. Without it `S-01` also
 * matches `test_s010_*`, and scoping a slice's gate to a different slice's
 * tests passes it without ever running its own — a false green, which is the
 * one outcome this whole gate exists to prevent.
 */
function testFilePattern(sliceId: string): RegExp {
  const runs = sliceId.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new RegExp(`${runs.join("[^a-z0-9]*")}(?![0-9])`);
}

/**
 * Every test file belonging to this slice, relative to the project root. Empty
 * means test-write named the suite something this cannot match, which is a
 * broken contract rather than a slice to grind through — see
 * `slicesWithoutTests`, which catches it before the build spends anything.
 */
/** The file each archetype's toolchain needs before it can run at all. */
const MANIFEST: Record<string, string> = {
  "cli-python": "pyproject.toml",
  "cli-node": "package.json",
};

/**
 * Derived from the recipe rather than listed separately, so a recipe that
 * starts invoking a new script cannot drift from the check that the script
 * exists. `npm run lint` on a package.json without a `lint` script exits 1,
 * which reads as a lint failure — the build then fails every slice twice over
 * a missing line of config.
 */
function requiredNpmScripts(recipe: VerifyStep[]): string[] {
  return recipe
    .filter((step) => step.command === "npm" && step.args[0] === "run" && step.args[1])
    .map((step) => step.args[1] as string);
}

/**
 * Whether this project can be graded at all, answered once before any slice is
 * paid for. Every problem here would otherwise surface as an ordinary slice
 * failure — the same output as code that does not work — and cost two attempts
 * on every slice to say so. The distinction matters: nothing was wrong with the
 * build, the gate was never able to run.
 */
export function verifiabilityProblem(id: string, archetype: string, env?: Env): string | null {
  const recipe = verifyRecipeFor(archetype);
  if (recipe.length === 0) {
    return `no verification recipe for archetype "${archetype}" — nothing could be checked`;
  }

  const dir = projectDir(id, env);
  const manifest = MANIFEST[archetype];
  if (manifest && !fs.existsSync(path.join(dir, manifest))) {
    return `${manifest} is missing, so the ${archetype} toolchain cannot run`;
  }

  if (archetype === "cli-node") {
    let scripts: Record<string, unknown> = {};
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      scripts = pkg.scripts ?? {};
    } catch {
      return "package.json is not valid JSON, so the cli-node toolchain cannot run";
    }
    const missing = requiredNpmScripts(recipe).filter((name) => !scripts[name]);
    if (missing.length > 0) {
      return `package.json has no ${missing.join(" or ")} script, which the gate runs`;
    }
  }

  return null;
}

export function sliceTestFiles(id: string, slice: Slice, env?: Env): string[] {
  const pattern = testFilePattern(slice.id);
  return walk(path.join(projectDir(id, env), TEST_DIR))
    .filter((rel) => pattern.test(path.basename(rel).toLowerCase()))
    .map((rel) => `${TEST_DIR}/${rel}`);
}

/**
 * Slices whose tests cannot be located, in plan order.
 *
 * Checked over the whole plan at once rather than slice by slice: the suite is
 * hash-locked before the first slice runs, so this answer cannot change
 * mid-build, and finding out at slice 7 costs six slices of real money to learn
 * something knowable for free beforehand.
 */
export function slicesWithoutTests(id: string, slices: Slice[], env?: Env): string[] {
  return slices.filter((s) => sliceTestFiles(id, s, env).length === 0).map((s) => s.id);
}

/**
 * Runs one step with no shell, ever. Slice ids and file paths reach these
 * argument lists, and a semicolon in a filename must stay a filename.
 */
function runStep(cwd: string, step: VerifyStep, testPaths: string[]): VerifyStepResult {
  const args = step.scopeable ? [...step.args, ...testPaths] : step.args;
  const proc = spawnSync(step.command, args, {
    cwd,
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });

  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`.trim();
  // A tool that is not installed reports no exit code. It is a failure, not a
  // skip: treating "could not run the linter" as a pass is a false green.
  if (proc.error) {
    return { name: step.name, ok: false, exitCode: null, output: output || proc.error.message };
  }
  return { name: step.name, ok: proc.status === 0, exitCode: proc.status, output };
}

/**
 * Runs steps in order and stops at the first failure. Later steps are omitted
 * from `steps` rather than marked skipped — the list is what ran, and a
 * `test` result that says "skipped" is one careless read away from "passed".
 *
 * Exported so the step machinery can be tested against commands that exist,
 * rather than against whichever toolchain happens to be on the machine.
 */
export function runRecipe(cwd: string, recipe: VerifyStep[], testPaths: string[]): VerifyResult {
  const steps: VerifyStepResult[] = [];
  for (const step of recipe) {
    const result = runStep(cwd, step, testPaths);
    steps.push(result);
    if (!result.ok) {
      return { ok: false, steps, tamperedTests: [], reason: `${step.name} failed` };
    }
  }
  return { ok: true, steps, tamperedTests: [] };
}

/**
 * The gate one slice has to pass.
 *
 * The lock is checked first and failing it returns before a single step runs.
 * A suite that has been edited proves nothing by going green — the cheapest way
 * to make a failing test pass is to change what it asserts — so there is no
 * point spending minutes of test time to find out how the edited version does.
 */
export function runVerify(id: string, archetype: string, slice: Slice, env?: Env): VerifyResult {
  if (Object.keys(readTestLock(id, env)).length === 0) {
    return {
      ok: false,
      steps: [],
      tamperedTests: [],
      reason: `the test suite was never locked — nothing pins what "${slice.id}" is being graded against`,
    };
  }

  const tamperedTests = verifyTestLock(id, TEST_DIR, env);
  if (tamperedTests.length > 0) {
    return {
      ok: false,
      steps: [],
      tamperedTests,
      reason: `the test suite changed since it was locked: ${tamperedTests.join(", ")}`,
    };
  }

  const recipe = verifyRecipeFor(archetype);
  if (recipe.length === 0) {
    return {
      ok: false,
      steps: [],
      tamperedTests: [],
      reason: `no gates available for archetype "${archetype}" — nothing about ${slice.id} was verified`,
    };
  }

  // Not "run the whole suite instead". An unscoped run makes early slices fail
  // on later slices' unimplemented tests, so the slice fails twice and takes
  // its dependents with it — expensive, and with nothing in the output naming
  // the real cause. The direction was never unsafe; the silence was.
  const testPaths = sliceTestFiles(id, slice, env);
  if (testPaths.length === 0) {
    return {
      ok: false,
      steps: [],
      tamperedTests: [],
      reason: `no test file matches ${slice.id} under ${TEST_DIR}/ — re-run \`sfo stage <id> test-write\` so each slice has a test file named for it`,
    };
  }

  return runRecipe(projectDir(id, env), recipe, testPaths);
}
