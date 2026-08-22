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
