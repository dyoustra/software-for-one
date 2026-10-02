import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifyRecipeFor, agentToolsFor, agentToolsForCommands, type VerifyStep } from "./archetype.js";
import { CONTRACTS_FILE, readContractFile, gateSteps, filesFor, stepCovers, contractCommands } from "./contracts.js";
import { readStack } from "./stack.js";
import { verifyTestLock, readTestLock, walkTestTree } from "./testlock.js";
import { scanAddedLines, formatHits } from "./gaming.js";
import { projectDir, type Env } from "./paths.js";
import { PIPELINE_STAGES } from "./stages.js";
import { readSlices, type Slice } from "./slices.js";

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
  const recipe = gateFor(id, env, archetype);
  if (recipe.length === 0) {
    return `no verification recipe: nothing is declared in .sfo/${CONTRACTS_FILE}, and "${archetype}" has no built-in one — nothing could be checked`;
  }
  // A declared contract is the project's own word on what it needs; the
  // checks below are what the built-in recipes needed to exist.
  if (readContractFile(id, env)) return null;

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

/**
 * The gate this project is graded by: its own locked contract, or for a
 * project made before contracts, the recipe its archetype used to have.
 */
export function gateFor(id: string, env?: Env, archetype?: string): VerifyStep[] {
  const contract = readContractFile(id, env);
  if (contract) return gateSteps(contract);
  try {
    return verifyRecipeFor(archetype ?? detectArchetype(id, env));
  } catch {
    return [];
  }
}

/**
 * Every test file of this slice, across every scoped gate step. Walked with
 * the lock's own filtered walk: an unfiltered one handed pytest a .pyc as a
 * test path, and failed a whole build attempt with exit 4.
 */
export function sliceTestFiles(id: string, slice: Slice, env?: Env): string[] {
  const scoped = gateFor(id, env).filter((step) => step.scopeable);
  // Before a gate exists, the convention test-write is told to follow.
  const steps = scoped.length > 0 ? scoped : [DEFAULT_SCOPED_STEP];
  return [...new Set(steps.flatMap((step) => filesFor(id, step, slice.id, env)))];
}

const DEFAULT_SCOPED_STEP: VerifyStep = { name: "test", command: "", args: [], scopeable: true, files: `${TEST_DIR}/**/*{slice}*` };

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
export function runRecipe(
  cwd: string,
  recipe: VerifyStep[],
  /** The same paths for every scoped step, or each step's own. */
  testPaths: string[] | ((step: VerifyStep) => string[]),
): VerifyResult {
  const steps: VerifyStepResult[] = [];
  for (const step of recipe) {
    const paths = typeof testPaths === "function" ? testPaths(step) : testPaths;
    // A scoped step given no paths would run unscoped — every slice's tests,
    // most of them for code that does not exist yet. A slice with no browser
    // tests simply has no browser step.
    if (step.scopeable && typeof testPaths === "function" && paths.length === 0) continue;
    const result = runStep(cwd, step, paths);
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
/**
 * Runs everything in the recipe except the tests themselves, against the suite
 * test-repair just produced, before it is locked.
 *
 * Once locked, a test file cannot be changed by anyone, and lint and typecheck
 * run over the whole tree on every slice. A lint error in a test file is then
 * one no slice can fix: every slice fails the gate twice and the build is lost.
 * On the first real project test-repair was told these steps must exit 0, did
 * not check, and locked four such errors. This is the check.
 */
export function checkSuiteBeforeLock(id: string, env?: Env): VerifyResult {
  const archetype = detectArchetype(id, env);
  const problem = verifiabilityProblem(id, archetype, env);
  if (problem) return { ok: false, steps: [], tamperedTests: [], reason: problem };

  const steps = gateFor(id, env, archetype).filter((step) => !step.scopeable);
  return runRecipe(projectDir(id, env), steps, []);
}

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

  const recipe = gateFor(id, env, archetype);
  if (recipe.length === 0) {
    return {
      ok: false,
      steps: [],
      tamperedTests: [],
      reason: `no gates available: nothing is declared for this project ("${archetype}"), so nothing about ${slice.id} was verified`,
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

  return withGamingScan(
    projectDir(id, env),
    runRecipe(projectDir(id, env), recipe, (step) => filesFor(id, step, slice.id, env)),
  );
}

/**
 * The last step of a passing gate: tests can pass over a stub, so passing is
 * not the end of the question. Runs only when everything else passed, so its
 * failure is never mistaken for the reason a test failed.
 */
function withGamingScan(cwd: string, result: VerifyResult): VerifyResult {
  if (!result.ok) return result;
  const hits = scanAddedLines(cwd);
  if (hits.length === 0) return result;
  return {
    ...result,
    ok: false,
    steps: [...result.steps, { name: "anti-gaming", ok: false, exitCode: 1, output: formatHits(hits) }],
  };
}

/**
 * The gate for a change made after the build, which may touch code any slice
 * relies on: every passed slice's tests at once. Not the unscoped suite, which
 * would also run the tests of slices that failed and were never expected to
 * pass.
 */
export function runPassedGate(
  id: string,
  archetype: string,
  passed: Slice[],
  env?: Env,
  /** Tests outside any slice that the change must also keep passing. */
  extraTests: string[] = [],
): VerifyResult {
  // The extra tests are new files by design — a follow-up's own tests, not
  // yet locked. Only they are excused: any other change to the suite,
  // including an edit to one already locked, is still tampering.
  const locked = readTestLock(id, env);
  const tamperedTests = verifyTestLock(id, TEST_DIR, env).filter(
    (p) => !(extraTests.includes(p) && !(p in locked)),
  );
  if (tamperedTests.length > 0) {
    return {
      ok: false,
      steps: [],
      tamperedTests,
      reason: `the test suite changed since it was locked: ${tamperedTests.join(", ")}`,
    };
  }
  const recipe = gateFor(id, env, archetype);
  if (recipe.length === 0) {
    return { ok: false, steps: [], tamperedTests: [], reason: `no gates available: nothing is declared for this project ("${archetype}")` };
  }
  const pathsFor = (step: VerifyStep): string[] => [
    ...new Set([
      ...passed.flatMap((s) => filesFor(id, step, s.id, env)),
      ...extraTests.filter((f) => stepCovers(step, f)),
    ]),
  ];
  return withGamingScan(projectDir(id, env), runRecipe(projectDir(id, env), recipe, pathsFor));
}

/**
 * Only the test step, only these files. For asking one question of the code
 * — does this test pass right now? — where install, lint and typecheck would
 * answer different ones.
 */
export function runTestFiles(id: string, archetype: string, files: string[], env?: Env): VerifyResult {
  const scoped = gateFor(id, env, archetype).filter((s) => s.scopeable && files.some((f) => stepCovers(s, f)));
  if (scoped.length === 0 || files.length === 0) {
    return { ok: false, steps: [], tamperedTests: [], reason: `no gate step runs ${files.join(", ") || "these files"} ("${archetype}")` };
  }
  return runRecipe(projectDir(id, env), scoped, (step) => files.filter((f) => stepCovers(step, f)));
}

export interface RedResult {
  /** Slices whose every scoped step already passes against the skeleton. */
  greenOnSkeleton: string[];
  /** Slices that had any scoped files to run. */
  checked: string[];
}

/**
 * Red before the build: each slice's own tests, run against the skeleton
 * test-repair left, should fail — nothing implements them yet. This is what
 * makes a gate the project declared for itself trustworthy: one that passes
 * on nothing (`echo ok`, a test command that collects no tests and exits 0)
 * passes here for every slice, and is refused before anything is spent.
 */
export function checkRedBeforeBuild(id: string, env?: Env): RedResult {
  const dir = projectDir(id, env);
  const scoped = gateFor(id, env).filter((s) => s.scopeable);
  const result: RedResult = { greenOnSkeleton: [], checked: [] };
  for (const slice of readSlices(id, env)) {
    const runs = scoped.map((step) => ({ step, files: filesFor(id, step, slice.id, env) })).filter((r) => r.files.length > 0);
    if (runs.length === 0) continue;
    result.checked.push(slice.id);
    if (runs.every(({ step, files }) => runRecipe(dir, [step], files).ok)) result.greenOnSkeleton.push(slice.id);
  }
  return result;
}

/** Stages from here on write or check code, and need to be able to run it. */
const FIRST_CODE_STAGE = "test-write";

/**
 * `--allowedTools` for a stage. Stages before any code exists (research, spec,
 * clarify, plan) get inspection and the web; from test-write on, the
 * archetype's toolchain too. An archetype record that fails to validate gets
 * no toolchain.
 */
export function agentToolsForStage(id: string, stage: string, env?: Env): string[] {
  const order = PIPELINE_STAGES as readonly string[];
  // The adjudicator rules on a test by running it, and smoke repair is a build
  // agent by another name, so both get the build's tools.
  const base =
    stage.startsWith("build-") ||
    stage.startsWith("adjudicate-") ||
    stage === "smoke-repair" ||
    stage.startsWith("feedback-") ||
    stage.startsWith("review-")
      ? "build"
      : stage;
  const runsCode = order.indexOf(base) >= order.indexOf(FIRST_CODE_STAGE);
  if (runsCode) {
    try {
      const contract = readContractFile(id, env);
      if (contract) return agentToolsForCommands(contractCommands(contract));
    } catch {
      // A malformed contract grants nothing it would have implied.
    }
  }
  let archetype = "unknown";
  if (runsCode) {
    try {
      archetype = detectArchetype(id, env);
    } catch {
      // Recorded but unregistered: grant nothing the recipe would have implied.
    }
  }
  return agentToolsFor(archetype, runsCode);
}
