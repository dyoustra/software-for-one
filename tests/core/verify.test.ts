import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runVerify,
  runRecipe,
  sliceTestFiles,
  slicesWithoutTests,
  detectArchetype,
  verifiabilityProblem,
  agentToolsForStage,
  TEST_DIR,
} from "../../src/core/verify.js";
import { ARCHETYPE_FILE } from "../../src/core/stack.js";
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

/** What the spec stage does with the stack it chose: writes the file itself. */
function recordArchetype(body: string): void {
  fs.writeFileSync(path.join(dir, ".sfo", ARCHETYPE_FILE), body);
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

  it("returns nothing when no file matches", () => {
    expect(sliceTestFiles("p", { ...SLICE, id: "S-99" }, env)).toEqual([]);
  });

  it("fails the gate rather than running the whole suite when it cannot find a slice's tests", () => {
    // Running the whole suite is safe but expensive and silent: an early slice
    // fails on later slices' unimplemented tests, twice, and nothing in the
    // output says the test file was simply named something else.
    lockTests("p", TEST_DIR, env);
    const result = runVerify("p", "cli-python", { ...SLICE, id: "S-99" }, env);

    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([]);
    expect(result.reason).toMatch(/no test file matches S-99/);
  });
});

describe("slicesWithoutTests", () => {
  it("names every slice whose tests cannot be located, in plan order", () => {
    const slices = [
      { ...SLICE, id: "S-99" },
      SLICE,
      { ...SLICE, id: "S-98" },
    ];
    expect(slicesWithoutTests("p", slices, env)).toEqual(["S-99", "S-98"]);
  });

  it("is empty when every slice has a file named for it", () => {
    expect(slicesWithoutTests("p", [SLICE], env)).toEqual([]);
  });
});

describe("detectArchetype", () => {
  it("prefers the archetype the spec stage recorded over the manifest", () => {
    // The manifest is evidence; the record is the decision. A Python project
    // whose build agent added a package.json must not start being graded as a
    // Node one.
    recordArchetype('{"archetype":"cli-python","why":"a Python CLI"}');
    fs.writeFileSync(path.join(dir, "package.json"), "{}");

    expect(detectArchetype("p", env)).toBe("cli-python");
  });

  it("uses the recorded archetype before any manifest exists at all", () => {
    // The state slice 1 is verified in on a real Python project: the record is
    // the only thing that can name the stack.
    recordArchetype('{"archetype":"cli-python","why":"a Python CLI"}');
    expect(detectArchetype("p", env)).toBe("cli-python");
  });

  it("keeps what the spec recorded rather than sniffing past it", () => {
    // Falling back to the manifest would grade the project as something nobody
    // chose. A description sfo has no recipe for is refused at build start
    // unless the project declared its own contract.
    recordArchetype('{"archetype":"cli-rust","why":"rust is fast"}');
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "[project]\n");

    expect(detectArchetype("p", env)).toBe("cli-rust");
  });

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

  it("still sniffs the manifest for a project recorded before ARCHETYPE.json existed", () => {
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "[project]\n");
    expect(detectArchetype("p", env)).toBe("cli-python");
  });
});

describe("verifiabilityProblem", () => {
  it("passes a python project whose manifest is present", () => {
    fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "p"\n');
    expect(verifiabilityProblem("p", "cli-python", env)).toBeNull();
  });

  it("names the missing manifest rather than letting the toolchain fail per slice", () => {
    // Without this, `uv sync` fails on every slice and reads as broken code.
    expect(verifiabilityProblem("p", "cli-python", env)).toMatch(/pyproject\.toml is missing/);
  });

  it("rejects an archetype with no recipe instead of grinding through slices", () => {
    expect(verifiabilityProblem("p", "unknown", env)).toMatch(/no verification recipe/);
  });

  it("names the npm scripts the recipe runs but the manifest lacks", () => {
    // `npm run lint` with no lint script exits 1, which reads as a lint
    // failure — the build then fails every slice over a missing config line.
    fs.writeFileSync(
      path.join(dir, "package.json"),
      '{"name":"p","scripts":{"test":"vitest run"}}',
    );
    const problem = verifiabilityProblem("p", "cli-node", env);
    expect(problem).toMatch(/lint/);
    expect(problem).toMatch(/typecheck/);
  });

  it("passes a node project declaring every script the recipe invokes", () => {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      '{"name":"p","scripts":{"lint":"eslint .","typecheck":"tsc --noEmit"}}',
    );
    expect(verifiabilityProblem("p", "cli-node", env)).toBeNull();
  });

  it("reports a malformed package.json as unrunnable, not as a passing gate", () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
    expect(verifiabilityProblem("p", "cli-node", env)).toMatch(/not valid JSON/);
  });
});

describe("sliceTestFiles ignores compiled files", () => {
  it("does not return a __pycache__ .pyc whose name contains the slice id", () => {
    // pytest writes tests/__pycache__/test_s01_*.pyc. Returned as a test path,
    // pytest exits 4 and the slice attempt is lost to the gate's own bug.
    const tests = path.join(dir, "tests");
    fs.mkdirSync(path.join(tests, "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(tests, "test_s01_enumeration.py"), "def test_x() -> None: ...\n");
    fs.writeFileSync(
      path.join(tests, "__pycache__", "test_s01_enumeration.cpython-313-pytest-9.1.1.pyc"),
      "bytecode",
    );
    const slice: Slice = { id: "S-01", name: "E", criterionIds: ["AC-001"], prerequisites: [] };

    expect(sliceTestFiles("p", slice, env)).toEqual(["tests/test_s01_enumeration.py"]);
  });
});

describe("agentToolsForStage", () => {
  it("gives stages before any code exists the web and inspection, no toolchain", () => {
    // User settings are not loaded, so research gets WebSearch only from here.
    fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "p"\n');
    for (const stage of ["research", "spec", "clarify", "plan"]) {
      const tools = agentToolsForStage("p", stage, env);
      expect(tools).toContain("WebSearch");
      expect(tools).toContain("Bash(grep *)");
      expect(tools).not.toContain("Bash(uv *)");
    }
  });

  it("gives code stages the gate's own toolchain, inspection and the network", () => {
    fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "p"\n');
    for (const stage of ["test-write", "test-repair", "build-S-01", "review"]) {
      const tools = agentToolsForStage("p", stage, env);
      expect(tools).toContain("Bash(uv *)");
      expect(tools).toContain("Bash(grep *)");
      expect(tools).toContain("Bash(curl *)");
      expect(tools).not.toContain("Bash(npm *)");
    }
  });

  it("grants no toolchain when the archetype is unknown", () => {
    const tools = agentToolsForStage("p", "build-S-01", env);
    expect(tools.some((t) => t.startsWith("Bash(uv") || t.startsWith("Bash(npm"))).toBe(false);
    expect(tools).toContain("Bash(ls *)");
  });
});

describe("runPassedGate and a follow-up's new tests", () => {
  it("excuses the new test files it was given, and nothing else", async () => {
    const { runPassedGate } = await import("../../src/core/verify.js");
    const { lockTests } = await import("../../src/core/testlock.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-gate-extra-"));
    const e = { SFO_HOME: home };
    const dir = path.join(home, "p");
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".sfo"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tests", "test_s01.py"), "def test_a(): pass\n");
    lockTests("p", "tests", e);

    // The real gate, on an archetype with no recipe: past the lock check it
    // stops at "no gates", so the reason says whether the lock let it through.
    fs.writeFileSync(path.join(dir, "tests", "test_feedback_x.py"), "def test_b(): pass\n");
    expect(runPassedGate("p", "unknown", [], e, ["tests/test_feedback_x.py"]).reason).toMatch(/no gates available/);
    expect(runPassedGate("p", "unknown", [], e, []).reason).toMatch(/changed since it was locked: tests\/test_feedback_x.py/);

    fs.writeFileSync(path.join(dir, "tests", "test_s01.py"), "def test_a(): assert 1\n");
    expect(runPassedGate("p", "unknown", [], e, ["tests/test_s01.py"]).reason).toMatch(/changed since it was locked: .*tests\/test_s01.py/);
  });
});
