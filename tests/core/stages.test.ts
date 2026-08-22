import { describe, it, expect } from "vitest";
import { PIPELINE_STAGES, nextStage, blocksOnHuman } from "../../src/core/stages.js";

describe("stages", () => {
  it("orders the full pipeline", () => {
    expect(PIPELINE_STAGES).toEqual([
      "capture",
      "research",
      "spec",
      "clarify",
      "plan",
      "test-write",
      "test-repair",
      "build",
      "review",
      "deliver",
    ]);
  });

  it("advances through the pipeline", () => {
    expect(nextStage("capture")).toBe("research");
    expect(nextStage("clarify")).toBe("plan");
    expect(nextStage("test-write")).toBe("test-repair");
  });

  it("writes the tests before it builds", () => {
    // The load-bearing ordering of the whole phase: tests are authored with no
    // implementation in existence, so they are a contract the build must meet
    // rather than a description of what it happened to do.
    const stages = PIPELINE_STAGES as readonly string[];
    expect(stages.indexOf("test-write")).toBeLessThan(stages.indexOf("build"));
    expect(stages.indexOf("test-repair")).toBeLessThan(stages.indexOf("build"));
  });

  it("returns null at the end of the pipeline", () => {
    expect(nextStage("deliver")).toBeNull();
  });

  it("rejects a stage it does not know", () => {
    expect(() => nextStage("verify")).toThrow(/unknown stage/);
  });

  it("marks clarify as blocking on a human", () => {
    expect(blocksOnHuman("clarify")).toBe(true);
    expect(blocksOnHuman("research")).toBe(false);
    expect(blocksOnHuman("build")).toBe(false);
  });
});
