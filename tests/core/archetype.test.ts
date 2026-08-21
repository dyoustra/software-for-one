import { describe, it, expect } from "vitest";
import { gitignoreFor, ARCHETYPES } from "../../src/core/archetype.js";

describe("gitignoreFor", () => {
  it("always ignores the stage logs", () => {
    expect(gitignoreFor("cli-python")).toContain(".sfo/logs/");
    expect(gitignoreFor("unknown-archetype")).toContain(".sfo/logs/");
  });

  it("ignores Python build and env output for the python CLI archetype", () => {
    const body = gitignoreFor("cli-python");
    expect(body).toContain("__pycache__/");
    expect(body).toContain(".venv/");
  });

  it("ignores node output for the node CLI archetype", () => {
    expect(gitignoreFor("cli-node")).toContain("node_modules/");
  });

  it("falls back to a safe default for an unknown archetype rather than an empty file", () => {
    // An unknown archetype must not mean 'commit everything'.
    const body = gitignoreFor("something-nobody-registered");
    expect(body).toContain("node_modules/");
    expect(body).toContain(".venv/");
  });

  it("lists the archetypes it knows", () => {
    expect(Object.keys(ARCHETYPES)).toContain("cli-python");
  });
});
