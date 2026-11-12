import { describe, it, expect } from "vitest";
import { deliveryProblem, parseDelivery } from "../../src/core/delivery.js";

const good = {
  what: "A dice roller for the terminal.",
  use: [{ kind: "command", command: "rolld 2d6+3", label: "Roll dice" }, { kind: "step", text: "Nothing to set up." }],
  examples: [{ say: "Roll with a modifier", do: "rolld 2d6+3" }],
  features: ["NdS+M notation"],
  gaps: [{ text: "Nobody has seen its real output.", weight: "note" }],
};

describe("DELIVERY.json", () => {
  it("is right when it matches the schema", () => {
    expect(deliveryProblem(JSON.stringify(good))).toBeNull();
    expect(parseDelivery(JSON.stringify(good))?.use[0]).toEqual({ kind: "command", command: "rolld 2d6+3", label: "Roll dice" });
  });

  it("says what is wrong, in words a retry can act on", () => {
    expect(deliveryProblem(null)).toBe("the deliver stage did not write .sfo/DELIVERY.json");
    expect(deliveryProblem("{not json")).toBe(".sfo/DELIVERY.json is not JSON");
    expect(deliveryProblem(JSON.stringify({ ...good, use: [] }))).toMatch(/does not match its schema: use — /);
    expect(deliveryProblem(JSON.stringify({ ...good, gaps: [{ text: "x", weight: "bad" }] }))).toMatch(/gaps\.0\.weight/);
    expect(deliveryProblem(JSON.stringify({ ...good, use: [{ kind: "url", url: "not a url" }] }))).toMatch(/use\.0\.url/);
  });

  it("reads as nothing when it is not right, rather than half", () => {
    expect(parseDelivery(JSON.stringify({ ...good, what: "" }))).toBeNull();
  });
});
