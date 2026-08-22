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
