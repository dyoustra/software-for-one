import { describe, it, expect } from "vitest";
import { loadPrompt } from "../../src/stages/prompts.js";

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
