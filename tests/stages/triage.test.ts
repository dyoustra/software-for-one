import { describe, it, expect, vi } from "vitest";
import { triage, TriageResultSchema, triageOutputSchema } from "../../src/stages/triage.js";

/** Stands in for runStructured: returns the inner `result` string, un-parsed. */
function fakeRun(payload: unknown) {
  return vi.fn().mockResolvedValue({
    text: JSON.stringify(payload),
    usage: {
      costUsd: 0.34,
      durationMs: 1000,
      numTurns: 1,
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 4,
    },
  });
}

describe("triageOutputSchema", () => {
  it("constrains verdict with a real JSON Schema enum, not a description", () => {
    const schema = triageOutputSchema() as any;
    expect(schema.properties.verdict.enum).toEqual([
      "ready",
      "underspecified",
      "out_of_scope",
    ]);
  });

  it("strips $schema, which the API rejects as an unknown key", () => {
    expect(triageOutputSchema()).not.toHaveProperty("$schema");
  });

  it("forbids extra properties", () => {
    expect((triageOutputSchema() as any).additionalProperties).toBe(false);
  });
});

describe("triage", () => {
  it("returns a ready verdict for a clear idea", async () => {
    const run = fakeRun({
      verdict: "ready",
      title: "Subway Tracker",
      reason: "Scope and platform are clear.",
      counterOffer: null,
    });
    const { result } = await triage("Build a subway arrival tracker for the L train", run);
    expect(result.verdict).toBe("ready");
    expect(result.title).toBe("Subway Tracker");
  });

  it("returns a counter-offer instead of rejecting an out-of-scope idea", async () => {
    const run = fakeRun({
      verdict: "out_of_scope",
      title: "Train An LLM",
      reason: "Training a foundation model is not buildable here.",
      counterOffer: "A local inference playground with a chat UI.",
    });
    const { result } = await triage("make an LLM", run);
    expect(result.verdict).toBe("out_of_scope");
    expect(result.counterOffer).toMatch(/playground/);
  });

  it("passes the constrained schema and a prompt carrying both instructions and idea", async () => {
    const run = fakeRun({ verdict: "ready", title: "T", reason: "r", counterOffer: null });
    await triage("track the L train", run);
    const args = run.mock.calls[0][0];
    expect(args.schema.properties.verdict.enum).toHaveLength(3);
    expect(args.prompt).toContain("You triage side-project ideas");
    expect(args.prompt).toContain("track the L train");
  });

  it("surfaces the usage the run reported", async () => {
    const run = fakeRun({ verdict: "ready", title: "T", reason: "r", counterOffer: null });
    const { usage } = await triage("x", run);
    expect(usage?.costUsd).toBe(0.34);
  });

  it("throws when the model returns a verdict outside the enum", async () => {
    const run = fakeRun({ verdict: "maybe", title: "t", reason: "r", counterOffer: null });
    await expect(triage("x", run)).rejects.toThrow();
  });

  it("propagates a failure from the runner", async () => {
    const run = vi.fn().mockRejectedValue(new Error("claude exited with code 1"));
    await expect(triage("x", run)).rejects.toThrow(/exited with code 1/);
  });

  it("accepts only the three known verdicts", () => {
    const bad = { verdict: "maybe", title: "t", reason: "r", counterOffer: null };
    expect(TriageResultSchema.safeParse(bad).success).toBe(false);
  });
});
