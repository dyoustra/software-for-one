import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PriorArtSchema, readPriorArt, writePriorArt, blocksPipeline } from "../../src/core/priorart.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-pa-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

const clear = {
  verdict: "clear_gap" as const,
  summary: "Nothing handles this at scale.",
  existing: [{ name: "ai-renamer", url: "https://example.com", gap: "no batching or resume" }],
};

describe("priorArt", () => {
  it("round-trips through disk", () => {
    writePriorArt("p", clear, env);
    expect(readPriorArt("p", env)?.verdict).toBe("clear_gap");
  });

  it("returns null when the research stage has not run", () => {
    expect(readPriorArt("p", env)).toBeNull();
  });

  it("accepts only the three verdicts", () => {
    expect(PriorArtSchema.safeParse({ ...clear, verdict: "probably" }).success).toBe(false);
  });

  it("requires a recommendation when the verdict is no_gap", () => {
    // Stopping without saying what to use instead is a dead end, which is the
    // thing this verdict exists to avoid.
    const noGap = { ...clear, verdict: "no_gap" as const };
    expect(PriorArtSchema.safeParse(noGap).success).toBe(false);
    expect(PriorArtSchema.safeParse({ ...noGap, recommendation: "use ai-renamer" }).success).toBe(true);
  });

  it("blocks the pipeline on no_gap and marginal_gap only", () => {
    expect(blocksPipeline("no_gap")).toBe(true);
    expect(blocksPipeline("marginal_gap")).toBe(true);
    expect(blocksPipeline("clear_gap")).toBe(false);
  });
});

describe("a clear gap with nothing to recommend", () => {
  it("accepts recommendation: null, which crashed the second real run", () => {
    expect(PriorArtSchema.safeParse({ verdict: "clear_gap", summary: "s", existing: [], recommendation: null }).success).toBe(true);
    expect(PriorArtSchema.safeParse({ verdict: "no_gap", summary: "s", existing: [], recommendation: null }).success).toBe(false);
  });
});

