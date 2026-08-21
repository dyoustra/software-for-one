import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseStructuredOutput, runStructured } from "../../src/runner/structured.js";

// A shell script, never the real `claude` binary.
const FAKE = path.resolve("tests/fixtures/fake-claude-structured.sh");
const SCHEMA = { type: "object", properties: { verdict: { enum: ["ready"] } } };

let argsFile: string;

beforeEach(() => {
  argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-struct-")), "args");
  process.env.FAKE_ARGS_FILE = argsFile;
  delete process.env.FAKE_EXIT;
  delete process.env.SFO_MAX_BUDGET_USD;
});

function recordedArgs(): string[] {
  return fs.readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
}

function payload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    is_error: false,
    total_cost_usd: 0.335725,
    usage: {
      input_tokens: 11,
      output_tokens: 22,
      cache_creation_input_tokens: 33,
      cache_read_input_tokens: 44,
    },
    duration_ms: 5000,
    num_turns: 1,
    result: '{"verdict":"ready"}',
    ...overrides,
  });
}

describe("parseStructuredOutput", () => {
  it("returns the inner result string un-parsed", () => {
    // `result` is a STRING of JSON, not a nested object; callers do the
    // second parse themselves.
    expect(parseStructuredOutput(payload()).text).toBe('{"verdict":"ready"}');
  });

  it("maps usage onto StageUsage field names", () => {
    expect(parseStructuredOutput(payload()).usage).toEqual({
      costUsd: 0.335725,
      durationMs: 5000,
      numTurns: 1,
      inputTokens: 11,
      outputTokens: 22,
      cacheCreationInputTokens: 33,
      cacheReadInputTokens: 44,
    });
  });

  it("handles a missing usage block without throwing", () => {
    const res = parseStructuredOutput(payload({ usage: undefined }));
    expect(res.text).toBe('{"verdict":"ready"}');
    expect(res.usage?.inputTokens).toBe(0);
    expect(res.usage?.costUsd).toBe(0.335725);
  });

  it("throws when the payload reports is_error", () => {
    const bad = payload({ is_error: true, result: "Credit balance too low" });
    expect(() => parseStructuredOutput(bad)).toThrow(/credit balance too low/i);
  });

  it("throws when stdout is not JSON, quoting what arrived", () => {
    expect(() => parseStructuredOutput("Warning: not logged in\n")).toThrow(
      /Warning: not logged in/,
    );
  });

  it("throws when the payload carries no result string", () => {
    expect(() => parseStructuredOutput(payload({ result: undefined }))).toThrow();
  });
});

describe("runStructured", () => {
  it("asks for the json envelope and passes the schema as one argument", async () => {
    const res = await runStructured({ prompt: "hi", schema: SCHEMA, bin: FAKE });
    expect(res.text).toBe('{"verdict":"ready"}');

    const args = recordedArgs();
    expect(args).toContain("--print");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5");
    // One argument, not a splatted object: JSON.parse must round-trip it.
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1])).toEqual(SCHEMA);
    // The prompt is last, so a schema with a leading dash cannot shadow it.
    expect(args[args.length - 1]).toBe("hi");
  });

  it("runs in a temp dir by default, away from any CLAUDE.md", async () => {
    await runStructured({ prompt: "hi", schema: SCHEMA, bin: FAKE });
    const cwd = fs.readFileSync(`${argsFile}.cwd`, "utf8").trim();
    expect(fs.realpathSync(cwd)).toBe(fs.realpathSync(os.tmpdir()));
  });

  it("passes the budget ceiling from the environment", async () => {
    process.env.SFO_MAX_BUDGET_USD = "2.5";
    await runStructured({ prompt: "hi", schema: SCHEMA, bin: FAKE });
    const args = recordedArgs();
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2.5");
  });

  it("omits the budget flag when nothing sets one", async () => {
    await runStructured({ prompt: "hi", schema: SCHEMA, bin: FAKE });
    expect(recordedArgs()).not.toContain("--max-budget-usd");
  });

  it("rejects with the stderr text on a non-zero exit", async () => {
    process.env.FAKE_EXIT = "1";
    await expect(runStructured({ prompt: "hi", schema: SCHEMA, bin: FAKE })).rejects.toThrow(
      /exited with code 1.*Please run \/login/s,
    );
  });

  it("rejects when the binary does not exist", async () => {
    await expect(
      runStructured({ prompt: "hi", schema: SCHEMA, bin: "/nonexistent/claude" }),
    ).rejects.toThrow(/failed to run/);
  });
});
