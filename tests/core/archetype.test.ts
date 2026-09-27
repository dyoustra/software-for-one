import { describe, it, expect } from "vitest";
import { gitignoreFor, ARCHETYPES, verifyRecipeFor, type VerifyStep } from "../../src/core/archetype.js";

describe("gitignoreFor", () => {
  it("always ignores the stage logs", () => {
    expect(gitignoreFor("cli-python")).toContain(".sfo/logs/");
    expect(gitignoreFor("unknown-archetype")).toContain(".sfo/logs/");
  });

  it("ignores Python build and env output for the python CLI archetype", () => {
    const body = gitignoreFor("cli-python");
    expect(body).toContain("__pycache__/");
    expect(body).toContain(".venv/");
  });

  it("ignores node output for the node CLI archetype", () => {
    expect(gitignoreFor("cli-node")).toContain("node_modules/");
  });

  it("falls back to a safe default for an unknown archetype rather than an empty file", () => {
    // An unknown archetype must not mean 'commit everything'.
    const body = gitignoreFor("something-nobody-registered");
    expect(body).toContain("node_modules/");
    expect(body).toContain(".venv/");
  });

  it("lists the archetypes it knows", () => {
    expect(Object.keys(ARCHETYPES)).toContain("cli-python");
  });
});

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

describe("recipe gates correctness, not style", () => {
  it("does not gate on formatting", () => {
    // A slice satisfying every criterion must not fail on blank lines, and
    // nothing in the build loop runs a fixing format pass before the gate.
    const names = verifyRecipeFor("cli-python").map((s: VerifyStep) => s.name);
    expect(names).not.toContain("format");
  });

  it("installs without --frozen, which a fresh project cannot satisfy", () => {
    // --frozen asserts a current uv.lock; a scaffolded project has none, and a
    // build agent adding dependencies is meant to change it.
    const install = verifyRecipeFor("cli-python").find((s: VerifyStep) => s.name === "install");
    expect(install?.args).not.toContain("--frozen");
  });
});

describe("smoke tests and the gate", () => {
  it("never lets a slice gate collect tests/smoke", async () => {
    const { verifyRecipeFor, SMOKE_DIR } = await import("../../src/core/archetype.js");
    const python = verifyRecipeFor("cli-python").find((s) => s.name === "test");
    const node = verifyRecipeFor("cli-node").find((s) => s.name === "test");
    expect(python?.args).toContain(`--ignore=${SMOKE_DIR}`);
    expect(node?.args.join(" ")).toContain(`--exclude ${SMOKE_DIR}/**`);
  });

  it("runs one smoke file on its own, and nothing for an unknown archetype", async () => {
    const { smokeRunnerFor } = await import("../../src/core/archetype.js");
    expect(smokeRunnerFor("cli-python", "tests/smoke/test_smoke_x.py")).toEqual({
      command: "uv",
      args: ["run", "pytest", "-q", "tests/smoke/test_smoke_x.py"],
    });
    expect(smokeRunnerFor("cli-rust", "f")).toBeNull();
  });
});
