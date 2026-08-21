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
    expect(names).toContain("cost");
    expect(names).toContain("criteria");
    expect(names).toContain("decisions");
    expect(names).toContain("why");
  });

  it("offers an explicit override for the prior-art verdict", () => {
    const run = buildProgram().commands.find((c) => c.name() === "run");
    expect(run?.options.map((o) => o.long)).toContain("--anyway");
  });
});
