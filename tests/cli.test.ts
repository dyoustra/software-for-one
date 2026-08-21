import { describe, it, expect } from "vitest";
import { buildProgram } from "../src/cli.js";

describe("buildProgram", () => {
  it("registers the expected commands", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toContain("new");
    expect(names).toContain("run");
    expect(names).toContain("status");
    expect(names).toContain("answer");
    expect(names).toContain("stage");
  });
});
