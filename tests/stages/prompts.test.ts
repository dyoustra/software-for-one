import { describe, it, expect } from "vitest";
import { loadPrompt } from "../../src/stages/prompts.js";
import { ARCHETYPE_NAMES } from "../../src/core/archetype.js";
import { ARCHETYPE_FILE } from "../../src/core/stack.js";
import { VERIFY_FILE } from "../../src/core/verifyRecord.js";

describe("loadPrompt", () => {
  it("loads each phase 1 agentic stage prompt", () => {
    for (const stage of ["research", "spec", "clarify"]) {
      expect(loadPrompt(stage).length).toBeGreaterThan(100);
    }
  });

  it("throws for an unknown stage", () => {
    expect(() => loadPrompt("nope")).toThrow(/no prompt/i);
  });
});

describe("prompts and the artifacts they are graded on", () => {
  it("tells the spec stage to record the stack where a machine can read it", () => {
    expect(loadPrompt("spec")).toContain(ARCHETYPE_FILE);
  });

  it("names every archetype the registry can actually verify", () => {
    // A name the registry does not know produces an empty recipe, so the prompt
    // has to offer exactly the registered ones — and adding an archetype
    // without offering it means the spec stage can never choose it.
    const spec = loadPrompt("spec");
    for (const name of ARCHETYPE_NAMES) expect(spec).toContain(name);
  });

  it("tells test-repair to create the manifest each archetype's gate needs", () => {
    // `uv sync` needs a pyproject.toml and `npm ci` needs a lockfile. Nothing
    // else in the pipeline writes either.
    const repair = loadPrompt("test-repair");
    expect(repair).toContain("pyproject.toml");
    expect(repair).toContain("package.json");
    expect(repair).toContain("package-lock.json");
  });

  it("points deliver at an artifact that exists", () => {
    // It is told to lead with what does not work; a nonexistent input means it
    // invents the section or omits it.
    expect(loadPrompt("deliver")).toContain(VERIFY_FILE);
  });
});
