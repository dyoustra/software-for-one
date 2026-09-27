import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { artifactPath, projectDir, sfoDir, type Env } from "./paths.js";
import { SMOKE_DIR } from "./archetype.js";

export const TEST_LOCK_FILE = "TESTS.lock.json";
export type TestLock = Record<string, string>;

/**
 * Build and cache artifacts that appear inside a test tree on their own.
 *
 * Filtered here rather than left to the caller, because a gate whose accuracy
 * depends on someone remembering an env var is not a gate. pytest writes
 * __pycache__ and .pytest_cache under tests/ by default, so without this the
 * first test run adds files nobody edited and every later verify reports a
 * violation. A gate that cries wolf gets switched off — and then the real
 * violation passes in silence, which is strictly worse than no gate at all.
 */
const IGNORED_DIRS = new Set([
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "node_modules",
  ".venv",
]);
const IGNORED_FILE = /\.(pyc|pyo)$|^\.DS_Store$/;

export function walkTestTree(root: string, base = ""): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      out.push(...walkTestTree(path.join(root, entry.name), rel));
    } else {
      if (IGNORED_FILE.test(entry.name)) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Every `conftest.py` outside the test tree. pytest loads them for the whole
 * run, so one can change how any test is collected or run, including skipping
 * it, without a test file changing. On the first real build a slice agent
 * wrote one at the repo root to work around a gate bug. That one was harmless,
 * but the lock could not tell. Hashing them here means a new one reads as an
 * added file and fails the gate like any other change to the suite.
 */
function collectionHooks(dir: string, testDir: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (rel === testDir || rel === SMOKE_DIR || entry.name === ".git" || entry.name === ".sfo") continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      out.push(...collectionHooks(dir, testDir, rel));
    } else if (entry.name === "conftest.py") {
      out.push(rel);
    }
  }
  return out;
}

/**
 * The smoke tests live beside the test tree, not in it, and are as much a
 * contract: a build agent that could edit them could decide what "works for
 * real" means.
 */
function hashTree(dir: string, testDir: string): TestLock {
  const lock: TestLock = {};
  for (const tree of [testDir, SMOKE_DIR]) {
    const root = path.join(dir, tree);
    for (const rel of walkTestTree(root)) {
      lock[`${tree}/${rel}`] = sha256(path.join(root, rel));
    }
  }
  for (const rel of collectionHooks(dir, testDir)) {
    lock[rel] = sha256(path.join(dir, rel));
  }
  return lock;
}

export function lockTests(id: string, testDir: string, env?: Env): void {
  const tree = hashTree(projectDir(id, env), testDir);
  if (!Object.keys(tree).some((p) => p.startsWith(`${testDir}/`))) {
    // An empty lock verifies clean forever, so a project with no tests would
    // sail through the gate that exists to prove tests were satisfied. If the
    // tree is empty here, test-write produced nothing — surface that now
    // rather than at delivery.
    throw new Error(`no test files found under ${testDir} — nothing to lock`);
  }

  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(
    artifactPath(id, TEST_LOCK_FILE, env),
    `${JSON.stringify(tree, null, 2)}\n`,
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
