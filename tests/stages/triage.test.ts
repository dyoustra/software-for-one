import { describe, it, expect, vi } from "vitest";
import {
  triage,
  selectTriagePath,
  sdkCostUsd,
  TriageResultSchema,
  triageOutputSchema,
} from "../../src/stages/triage.js";

const READY = {
  verdict: "ready",
  title: "Subway Tracker",
  reason: "Scope and platform are clear.",
  counterOffer: null,
};

const USAGE = {
  costUsd: 0.34,
  durationMs: 1000,
  numTurns: 1,
  inputTokens: 1,
  outputTokens: 2,
  cacheCreationInputTokens: 3,
  cacheReadInputTokens: 4,
};

/** Stands in for the CLI runner: returns the inner `result` string, un-parsed. */
function fakeCli(payload: unknown) {
  return vi.fn().mockResolvedValue({ text: JSON.stringify(payload), usage: USAGE });
}

/** Stands in for the SDK call: same contract, different arguments. */
function fakeSdk(payload: unknown) {
  return vi.fn().mockResolvedValue({ text: JSON.stringify(payload), usage: USAGE });
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

describe("selectTriagePath", () => {
  // Presence check rather than a trial call: selection must be free and
  // deterministic, and must never itself spend money.
  it("picks the SDK when ANTHROPIC_API_KEY is set", () => {
    expect(selectTriagePath({ ANTHROPIC_API_KEY: "sk-ant-x" })).toBe("sdk");
  });

  it("takes the CLI path when only ANTHROPIC_AUTH_TOKEN is set", () => {
    // An OAuth token there needs an anthropic-beta header the SDK never sends,
    // so the SDK would 401. The fallback exists for exactly this case.
    expect(selectTriagePath({ ANTHROPIC_AUTH_TOKEN: "oat-x" })).toBe("cli");
  });

  it("falls back to the CLI when neither is set", () => {
    expect(selectTriagePath({})).toBe("cli");
  });

  it("ignores an empty key, which authenticates as nothing", () => {
    expect(selectTriagePath({ ANTHROPIC_API_KEY: "" })).toBe("cli");
  });
});

describe("sdkCostUsd", () => {
  it("matches a hand-computed example", () => {
    // 1000 * $5 + 2000 * $6.25 + 4000 * $0.50 + 500 * $25, per million:
    // (5000 + 12500 + 2000 + 12500) / 1e6 = 0.032
    expect(
      sdkCostUsd({
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 2000,
        cacheReadInputTokens: 4000,
      }),
    ).toBeCloseTo(0.032, 10);
  });

  it("prices cache writes above and cache reads below plain input", () => {
    const plain = sdkCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    const write = sdkCostUsd({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 0,
    });
    const read = sdkCostUsd({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    });
    expect(plain).toBeCloseTo(5, 10);
    expect(write).toBeCloseTo(6.25, 10);
    expect(read).toBeCloseTo(0.5, 10);
  });

  it("is never zero for a call that used tokens", () => {
    // A zero here would show a real SDK call as free in `sfo cost`.
    expect(
      sdkCostUsd({
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ).toBeGreaterThan(0);
  });
});

describe("triage routing", () => {
  it("uses the injected SDK implementation on the sdk path", async () => {
    const sdk = fakeSdk(READY);
    const cli = fakeCli(READY);
    const outcome = await triage("track the L train", { path: "sdk", sdk, cli });

    expect(sdk).toHaveBeenCalledTimes(1);
    expect(cli).not.toHaveBeenCalled();
    expect(outcome.via).toBe("sdk");
  });

  it("uses the injected CLI implementation on the cli path", async () => {
    const sdk = fakeSdk(READY);
    const cli = fakeCli(READY);
    const outcome = await triage("track the L train", { path: "cli", sdk, cli });

    expect(cli).toHaveBeenCalledTimes(1);
    expect(sdk).not.toHaveBeenCalled();
    expect(outcome.via).toBe("cli");
  });

  it("produces an identical result from equivalent payloads on either path", async () => {
    const fromSdk = await triage("x", { path: "sdk", sdk: fakeSdk(READY) });
    const fromCli = await triage("x", { path: "cli", cli: fakeCli(READY) });
    expect(fromSdk.result).toEqual(fromCli.result);
  });

  it("sends the system prompt apart from the idea on the sdk path", async () => {
    const sdk = fakeSdk(READY);
    await triage("track the L train", { path: "sdk", sdk });
    const args = sdk.mock.calls[0][0];

    expect(args.system).toContain("You triage side-project ideas");
    expect(args.system).not.toContain("track the L train");
    expect(args.prompt).toBe("track the L train");
    expect(args.schema.properties.verdict.enum).toHaveLength(3);
  });

  it("concatenates the system prompt with the idea on the cli path", async () => {
    // The CLI takes a single prompt argument and has no separate system field.
    const cli = fakeCli(READY);
    await triage("track the L train", { path: "cli", cli });
    const args = cli.mock.calls[0][0];

    expect(args.prompt).toContain("You triage side-project ideas");
    expect(args.prompt).toContain("track the L train");
    expect(args.schema.properties.verdict.enum).toHaveLength(3);
  });

  it("surfaces the usage the chosen path reported", async () => {
    const { usage } = await triage("x", { path: "cli", cli: fakeCli(READY) });
    expect(usage?.costUsd).toBe(0.34);
  });

  it("returns a counter-offer instead of rejecting an out-of-scope idea", async () => {
    const payload = {
      verdict: "out_of_scope",
      title: "Train An LLM",
      reason: "Training a foundation model is not buildable here.",
      counterOffer: "A local inference playground with a chat UI.",
    };
    const { result } = await triage("make an LLM", { path: "sdk", sdk: fakeSdk(payload) });
    expect(result.verdict).toBe("out_of_scope");
    expect(result.counterOffer).toMatch(/playground/);
  });

  it("rejects a verdict outside the enum on the sdk path", async () => {
    const bad = { verdict: "maybe", title: "t", reason: "r", counterOffer: null };
    await expect(triage("x", { path: "sdk", sdk: fakeSdk(bad) })).rejects.toThrow();
  });

  it("rejects a verdict outside the enum on the cli path", async () => {
    const bad = { verdict: "maybe", title: "t", reason: "r", counterOffer: null };
    await expect(triage("x", { path: "cli", cli: fakeCli(bad) })).rejects.toThrow();
  });

  it("propagates a failure from the chosen path", async () => {
    const cli = vi.fn().mockRejectedValue(new Error("claude exited with code 1"));
    await expect(triage("x", { path: "cli", cli })).rejects.toThrow(/exited with code 1/);
  });

  it("accepts only the three known verdicts", () => {
    const bad = { verdict: "maybe", title: "t", reason: "r", counterOffer: null };
    expect(TriageResultSchema.safeParse(bad).success).toBe(false);
  });
});
