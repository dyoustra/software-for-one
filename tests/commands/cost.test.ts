import { describe, it, expect } from "vitest";
import { formatProjectCost, formatAllCosts } from "../../src/commands/cost.js";
import type { CostRecord, CostVia } from "../../src/core/cost.js";

function rec(stage: string, costUsd: number, ok = true, via: CostVia = "cli"): CostRecord {
  return {
    stage,
    at: "2026-08-21T00:00:00.000Z",
    ok,
    via,
    usage: {
      costUsd,
      durationMs: 1000,
      numTurns: 1,
      inputTokens: 1234,
      outputTokens: 20,
      cacheCreationInputTokens: 10106,
      cacheReadInputTokens: 19703,
    },
  };
}

describe("formatProjectCost", () => {
  it("lists every stage and a total", () => {
    const out = formatProjectCost([rec("research", 0.1), rec("spec", 0.25)]);
    expect(out).toContain("research");
    expect(out).toContain("spec");
    expect(out).toMatch(/total/i);
    expect(out).toContain("0.3500");
  });

  it("formats money to four places and tokens with separators", () => {
    const out = formatProjectCost([rec("research", 0.1)]);
    expect(out).toContain("0.1000");
    expect(out).toContain("1,234");
  });

  it("collapses repeated runs of one stage into a row that shows the run count", () => {
    const out = formatProjectCost([rec("research", 0.1, false), rec("research", 0.2)]);
    expect(out.split("\n").filter((l) => l.includes("research"))).toHaveLength(1);
    expect(out).toContain("0.3000");
    expect(out).toMatch(/research\s+2/);
  });

  it("says so when nothing has been spent", () => {
    expect(formatProjectCost([])).toMatch(/no cost/i);
  });

  it("shows which route each stage took, so cheap and expensive runs differ", () => {
    const out = formatProjectCost([rec("triage", 0.01, true, "sdk"), rec("spec", 0.25)]);
    expect(out).toContain("VIA");
    expect(out).toMatch(/triage\s+1\s+sdk/);
    expect(out).toMatch(/spec\s+1\s+cli/);
  });

  it("names both routes when a stage ran on each", () => {
    const out = formatProjectCost([
      rec("triage", 0.01, false, "sdk"),
      rec("triage", 0.34, true, "cli"),
    ]);
    expect(out).toMatch(/triage\s+2\s+cli\+sdk/);
  });
});

describe("formatAllCosts", () => {
  it("gives a line per project plus a grand total", () => {
    const out = formatAllCosts([
      { id: "aaa", records: [rec("research", 0.1)] },
      { id: "bbb", records: [rec("spec", 0.25)] },
    ]);
    expect(out).toContain("aaa");
    expect(out).toContain("bbb");
    expect(out).toMatch(/total/i);
    expect(out).toContain("0.3500");
  });

  it("says so when there are no projects", () => {
    expect(formatAllCosts([])).toMatch(/no projects/i);
  });

  it("shows the route per project", () => {
    const out = formatAllCosts([
      { id: "aaa", records: [rec("triage", 0.01, true, "sdk")] },
      { id: "bbb", records: [rec("spec", 0.25)] },
    ]);
    expect(out).toMatch(/aaa\s+1\s+sdk/);
    expect(out).toMatch(/bbb\s+1\s+cli/);
  });
});
