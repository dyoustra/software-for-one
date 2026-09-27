import { describe, it, expect } from "vitest";
import { FallbackRunner } from "../../src/runner/fallback.js";
import type { Runner, RunStageInput, StageResult } from "../../src/runner/types.js";

class Scripted implements Runner {
  calls: string[] = [];
  constructor(private readonly results: Partial<StageResult>[]) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    this.calls.push(input.prompt);
    const next = this.results.shift() ?? {};
    return { ok: true, exitCode: 0, logPath: input.logPath, ...next };
  }
}

const input = (prompt: string): RunStageInput => ({ workdir: "/w", prompt, logPath: `/l/${prompt}.log` });

describe("FallbackRunner", () => {
  it("stays on the plan while nothing is limited", async () => {
    const plan = new Scripted([{}, {}]);
    const key = new Scripted([]);
    const r = new FallbackRunner(plan, key, () => {}, () => {});
    await r.runStage(input("a"));
    await r.runStage(input("b"));
    expect(plan.calls).toEqual(["a", "b"]);
    expect(key.calls).toEqual([]);
  });

  it("repeats the limited stage on the key, stays there, and hands over the abandoned attempt", async () => {
    const plan = new Scripted([{ ok: false, exitCode: 1, limited: { window: "five_hour" } }]);
    const key = new Scripted([{ billing: "api" }, {}]);
    const abandoned: string[] = [];
    const logs: string[] = [];
    const r = new FallbackRunner(plan, key, (i) => abandoned.push(i.prompt), (m) => logs.push(m));

    const first = await r.runStage(input("research"));
    await r.runStage(input("spec"));

    expect(first.ok).toBe(true);
    expect(first.billing).toBe("api");
    expect(plan.calls).toEqual(["research"]);
    expect(key.calls).toEqual(["research", "spec"]);
    expect(abandoned).toEqual(["research"]);
    expect(logs[0]).toMatch(/continuing on your API key, which is billed/);
  });
});
