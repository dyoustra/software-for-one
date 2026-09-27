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

describe("build artifacts must not trip the lock", () => {
  it("ignores __pycache__ and .pytest_cache written by a test run", () => {
    // Without this the first pytest run adds files nobody edited, every later
    // verify reports a violation, and the gate gets switched off as noise.
    lockTests("p", "tests", env);

    fs.mkdirSync(path.join(dir, "tests", "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tests", "__pycache__", "test_a.cpython-312.pyc"), "bytecode");
    fs.mkdirSync(path.join(dir, "tests", ".pytest_cache", "v", "cache"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tests", ".pytest_cache", "v", "cache", "lastfailed"), "{}");

    expect(verifyTestLock("p", "tests", env)).toEqual([]);
  });

  it("still catches a real edit alongside cache noise", () => {
    lockTests("p", "tests", env);
    fs.mkdirSync(path.join(dir, "tests", "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tests", "__pycache__", "x.pyc"), "bytecode");
    fs.writeFileSync(path.join(dir, "tests", "test_a.py"), "def test_a(): assert False\n");

    expect(verifyTestLock("p", "tests", env)).toEqual(["tests/test_a.py"]);
  });
});

describe("an empty test tree is a failure, not a pass", () => {
  it("refuses to lock a tree with no test files", () => {
    fs.rmSync(path.join(dir, "tests"), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
    expect(() => lockTests("p", "tests", env)).toThrow(/nothing to lock/i);
  });

  it("refuses to lock a tree containing only build artifacts", () => {
    fs.rmSync(path.join(dir, "tests"), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "tests", "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tests", "__pycache__", "x.pyc"), "bytecode");
    expect(() => lockTests("p", "tests", env)).toThrow(/nothing to lock/i);
  });
});

describe("collection hooks outside the test tree", () => {
  it("fails the lock when a conftest.py appears at the repo root", () => {
    // A root conftest.py can skip or deselect any test without a test file
    // changing. A slice agent wrote one on the first real build.
    lockTests("p", "tests", env);
    fs.writeFileSync(path.join(dir, "conftest.py"), "collect_ignore = ['tests']\n");

    expect(verifyTestLock("p", "tests", env)).toEqual(["conftest.py"]);
  });

  it("fails the lock when a locked root conftest.py is edited", () => {
    fs.writeFileSync(path.join(dir, "conftest.py"), "# original\n");
    lockTests("p", "tests", env);
    fs.writeFileSync(path.join(dir, "conftest.py"), "collect_ignore = ['tests']\n");

    expect(verifyTestLock("p", "tests", env)).toEqual(["conftest.py"]);
  });

  it("ignores a conftest.py inside a virtualenv", () => {
    lockTests("p", "tests", env);
    fs.mkdirSync(path.join(dir, ".venv", "lib"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".venv", "lib", "conftest.py"), "# third party\n");

    expect(verifyTestLock("p", "tests", env)).toEqual([]);
  });

  it("still refuses to lock when the only file is a root conftest.py", () => {
    fs.rmSync(path.join(dir, "tests"), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(dir, "conftest.py"), "# hooks\n");

    expect(() => lockTests("p", "tests", env)).toThrow(/nothing to lock/);
  });
});

describe("the smoke tests beside the test tree", () => {
  it("are locked, so an edit to one fails the gate like any other test", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-lock-smoke-"));
    const e = { SFO_HOME: home };
    const dir = path.join(home, "p");
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
    fs.mkdirSync(path.join(dir, "smoke"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tests", "test_a.py"), "a\n");
    fs.writeFileSync(path.join(dir, "smoke", "test_smoke_x.py"), "x\n");
    lockTests("p", "tests", e);
    fs.writeFileSync(path.join(dir, "smoke", "test_smoke_x.py"), "y\n");
    expect(verifyTestLock("p", "tests", e)).toEqual(["smoke/test_smoke_x.py"]);
  });
});
