import { describe, it, expect } from "vitest";
import { PHASE_1_STAGES, nextStage, blocksOnHuman } from "../../src/core/stages.js";

describe("stages", () => {
  it("orders the phase 1 pipeline", () => {
    expect(PHASE_1_STAGES).toEqual(["capture", "research", "spec", "clarify"]);
  });

  it("advances through the pipeline", () => {
    expect(nextStage("capture")).toBe("research");
    expect(nextStage("research")).toBe("spec");
  });

  it("returns null at the end of the phase", () => {
    expect(nextStage("clarify")).toBeNull();
  });

  it("marks only clarify as blocking on a human", () => {
    expect(blocksOnHuman("clarify")).toBe(true);
    expect(blocksOnHuman("research")).toBe(false);
  });
});
