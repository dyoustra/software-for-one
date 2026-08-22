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
