import { describe, it, expect } from "vitest";
import { formatWhy } from "../../src/commands/why.js";
import type { PriorArt } from "../../src/core/priorart.js";

const noGap: PriorArt = {
  verdict: "no_gap",
  summary: "ai-renamer already renames files with a model.",
  existing: [
    { name: "ai-renamer", url: "https://example.com/ai-renamer", gap: "no batch undo" },
  ],
  recommendation: "use ai-renamer instead",
};

describe("formatWhy", () => {
  it("says so plainly when research has not run", () => {
    expect(formatWhy(null)).toMatch(/research/);
  });

  it("renders the verdict, the summary and what to use instead", () => {
    const out = formatWhy(noGap);
    expect(out).toContain("no_gap");
    expect(out).toContain("ai-renamer already renames files");
    expect(out).toContain("use ai-renamer instead");
  });

  it("lists the existing tools with their links and gaps", () => {
    const out = formatWhy(noGap);
    expect(out).toContain("https://example.com/ai-renamer");
    expect(out).toContain("no batch undo");
  });

  it("does not claim the pipeline stopped when the gap was clear", () => {
    const out = formatWhy({ verdict: "clear_gap", summary: "nothing does this", existing: [] });
    expect(out).not.toMatch(/stopped/);
  });

  it("marks a blocking verdict as the reason the pipeline stopped", () => {
    expect(formatWhy(noGap)).toMatch(/stopped/);
  });
});
