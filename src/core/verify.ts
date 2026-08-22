import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifyRecipeFor, type VerifyStep } from "./archetype.js";
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
 * The spec stage records the chosen stack in prose, so there is no
 * machine-readable archetype on disk to read back. The manifest is the next
 * best evidence and has the advantage of describing what the project actually
 * became rather than what was planned. An unrecognised project falls through to
 * "unknown", which has no recipe — the gate then reports that it verified
 * nothing instead of passing.
 */
export function detectArchetype(id: string, env?: Env): string {
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
 * when nothing matches, and the caller then runs the whole suite: an unscoped
 * run can only be stricter than a scoped one, so the failure mode is a slice
 * that has to wait for its siblings, not one that passes unverified.
 */
export function sliceTestFiles(id: string, slice: Slice, env?: Env): string[] {
  const pattern = testFilePattern(slice.id);
  return walk(path.join(projectDir(id, env), TEST_DIR))
    .filter((rel) => pattern.test(path.basename(rel).toLowerCase()))
    .map((rel) => `${TEST_DIR}/${rel}`);
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

  return runRecipe(projectDir(id, env), recipe, sliceTestFiles(id, slice, env));
}
