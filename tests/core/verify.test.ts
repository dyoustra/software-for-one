import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runVerify,
  runRecipe,
  sliceTestFiles,
  detectArchetype,
  TEST_DIR,
} from "../../src/core/verify.js";
import { lockTests } from "../../src/core/testlock.js";
import type { Slice } from "../../src/core/slices.js";
import type { VerifyStep } from "../../src/core/archetype.js";

let env: Record<string, string>;
let dir: string;

const SLICE: Slice = {
  id: "S-01",
  name: "Enumeration",
  criterionIds: ["AC-001"],
  prerequisites: [],
};

/** A step that always succeeds, and leaves proof it ran. */
function touching(name: string, file: string, exit = 0): VerifyStep {
  return {
    name,
    command: process.execPath,
    args: ["-e", `require("fs").writeFileSync(${JSON.stringify(file)}, "");process.exit(${exit})`],
    scopeable: false,
  };
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-verify-")) };
  dir = path.join(env.SFO_HOME, "p");
  fs.mkdirSync(path.join(dir, ".sfo"), { recursive: true });
  fs.mkdirSync(path.join(dir, TEST_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, TEST_DIR, "test_s01_enumeration.py"), "def test_a(): pass\n");
});

describe("runRecipe", () => {
  it("reports every step of a recipe that passes", () => {
    const result = runRecipe(dir, [touching("lint", "lint.ran"), touching("test", "test.ran")], []);

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual(["lint", "test"]);
    expect(result.steps.every((s) => s.ok)).toBe(true);
  });

  it("stops at the first failing step instead of running the rest", () => {
    const result = runRecipe(
      dir,
      [touching("lint", "lint.ran", 1), touching("test", "test.ran")],
      [],
    );

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.name)).toEqual(["lint"]);
    // The report could lie; the filesystem cannot. `test` never ran.
    expect(fs.existsSync(path.join(dir, "test.ran"))).toBe(false);
  });

  it("fails rather than passes when the tool is not installed at all", () => {
    // A gate that treats "command not found" as a skip reports a green run for
    // checks that never happened.
    const missing: VerifyStep = {
      name: "lint",
      command: "sfo-no-such-tool-exists",
      args: [],
      scopeable: false,
    };
    const result = runRecipe(dir, [missing], []);

    expect(result.ok).toBe(false);
    expect(result.steps[0].exitCode).toBeNull();
  });

  it("scopes only the steps that say they are scopeable", () => {
    fs.writeFileSync(
      path.join(dir, "argv.js"),
      `require("fs").appendFileSync("argv.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n")`,
    );
    const step = (name: string, scopeable: boolean): VerifyStep => ({
      name,
      command: process.execPath,
      args: ["argv.js"],
      scopeable,
    });

    runRecipe(dir, [step("lint", false), step("test", true)], ["tests/test_s01_enumeration.py"]);

    const seen = fs
      .readFileSync(path.join(dir, "argv.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(seen).toEqual([[], ["tests/test_s01_enumeration.py"]]);
  });
});

describe("runVerify", () => {
  it("fails the gate on a tampered test file before running a single step", () => {
    lockTests("p", TEST_DIR, env);
    fs.writeFileSync(path.join(dir, TEST_DIR, "test_s01_enumeration.py"), "def test_a(): pass # ok\n");

    const result = runVerify("p", "cli-python", SLICE, env);

    expect(result.ok).toBe(false);
    expect(result.tamperedTests).toEqual(["tests/test_s01_enumeration.py"]);
    // The point of the gate: a suite that was edited is not worth running, so
    // no step may have executed. An empty `steps` is that claim.
    expect(result.steps).toEqual([]);
  });

  it("refuses to grade a project whose suite was never locked", () => {
    const result = runVerify("p", "cli-python", SLICE, env);

    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([]);
    expect(result.reason).toMatch(/never locked/);
  });

  it("reports no gates available rather than success for an archetype with no recipe", () => {
    lockTests("p", TEST_DIR, env);

    const result = runVerify("p", "unknown", SLICE, env);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no gates available/);
  });
});

describe("scoping a slice to its own tests", () => {
  it("finds the test file named for the slice", () => {
    expect(sliceTestFiles("p", SLICE, env)).toEqual(["tests/test_s01_enumeration.py"]);
  });

  it("does not mistake a longer slice number for its own", () => {
    // Scoping S-01 to S-010's tests passes S-01 without ever running its own.
    fs.writeFileSync(path.join(dir, TEST_DIR, "test_s010_other.py"), "def test_b(): pass\n");
    expect(sliceTestFiles("p", SLICE, env)).toEqual(["tests/test_s01_enumeration.py"]);
  });

  it("takes every file a slice is split across", () => {
    fs.writeFileSync(path.join(dir, TEST_DIR, "test_s01_more.py"), "def test_c(): pass\n");
    expect(sliceTestFiles("p", SLICE, env)).toEqual([
      "tests/test_s01_enumeration.py",
      "tests/test_s01_more.py",
    ]);
  });

  it("returns nothing when no file matches, so the whole suite runs", () => {
    expect(sliceTestFiles("p", { ...SLICE, id: "S-99" }, env)).toEqual([]);
  });
});

describe("detectArchetype", () => {
  it("reads the python archetype off its manifest", () => {
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "[project]\n");
    expect(detectArchetype("p", env)).toBe("cli-python");
  });

  it("reads the node archetype off its manifest", () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    expect(detectArchetype("p", env)).toBe("cli-node");
  });

  it("admits it does not know rather than guessing a recipe", () => {
    expect(detectArchetype("p", env)).toBe("unknown");
  });
});
