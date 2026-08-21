import { describe, it, expect, vi } from "vitest";
import { triage, TriageResultSchema, triageOutputSchema } from "../../src/stages/triage.js";

function fakeClient(payload: unknown) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify(payload) }],
      }),
    },
  };
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
    const client = fakeClient({
      verdict: "ready",
      title: "Subway Tracker",
      reason: "Scope and platform are clear.",
      counterOffer: null,
    });
    const res = await triage("Build a subway arrival tracker for the L train", client as never);
    expect(res.verdict).toBe("ready");
    expect(res.title).toBe("Subway Tracker");
  });

  it("returns a counter-offer instead of rejecting an out-of-scope idea", async () => {
    const client = fakeClient({
      verdict: "out_of_scope",
      title: "Train An LLM",
      reason: "Training a foundation model is not buildable here.",
      counterOffer: "A local inference playground with a chat UI.",
    });
    const res = await triage("make an LLM", client as never);
    expect(res.verdict).toBe("out_of_scope");
    expect(res.counterOffer).toMatch(/playground/);
  });

  it("requests opus and passes the structured format", async () => {
    const client = fakeClient({ verdict: "ready", title: "T", reason: "r", counterOffer: null });
    await triage("anything", client as never);
    const args = client.messages.create.mock.calls[0][0];
    expect(args.model).toBe("claude-opus-5");
    expect(args.output_config.format.type).toBe("json_schema");
    expect(args.output_config.format.schema.properties.verdict.enum).toHaveLength(3);
  });

  it("throws when the response carries no text block", async () => {
    const client = { messages: { create: vi.fn().mockResolvedValue({ content: [] }) } };
    await expect(triage("x", client as never)).rejects.toThrow(/no text/i);
  });

  it("throws when the model returns a verdict outside the enum", async () => {
    const client = fakeClient({ verdict: "maybe", title: "t", reason: "r", counterOffer: null });
    await expect(triage("x", client as never)).rejects.toThrow();
  });

  it("accepts only the three known verdicts", () => {
    const bad = { verdict: "maybe", title: "t", reason: "r", counterOffer: null };
    expect(TriageResultSchema.safeParse(bad).success).toBe(false);
  });
});
