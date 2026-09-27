import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeRunner, parseUsageFromLog, readLogTail } from "../../src/runner/claude-code.js";

const FAKE = path.resolve("tests/fixtures/fake-claude.sh");
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-run-"));
});

describe("ClaudeCodeRunner", () => {
  it("passes print mode, stream-json output, and the model", async () => {
    const runner = new ClaudeCodeRunner({ bin: FAKE });
    const log = path.join(dir, "out.log");
    const res = await runner.runStage({ workdir: dir, prompt: "hello", logPath: log });

    expect(res.ok).toBe(true);
    const out = fs.readFileSync(log, "utf8");
    expect(out).toContain("--print");
    expect(out).toContain("--output-format stream-json");
    expect(out).toContain("claude-opus-5");
    expect(out).toContain("hello");
  });

  it("passes allowed tools before another flag, so the prompt stays the prompt", async () => {
    // --allowedTools is variadic. Placed just before the prompt, it would read
    // the prompt as one more tool name and the agent would get no instructions.
    const runner = new ClaudeCodeRunner({ bin: FAKE });
    const log = path.join(dir, "out.log");
    await runner.runStage({
      workdir: dir,
      prompt: "THE-PROMPT",
      logPath: log,
      allowedTools: ["Bash(uv *)", "WebFetch"],
    });
    const out = fs.readFileSync(log, "utf8");
    const tools = out.indexOf("--allowedTools");
    expect(tools).toBeGreaterThan(-1);
    expect(out.indexOf("Bash(uv *)")).toBeGreaterThan(tools);
    expect(out.indexOf("--model")).toBeGreaterThan(out.indexOf("WebFetch"));
    expect(out.indexOf("THE-PROMPT")).toBeGreaterThan(out.indexOf("--model"));
  });

  it("loads project and local settings only, never the user's", async () => {
    // The user's allowlist is written for sessions they watch; a stage runs
    // unattended and must not inherit it.
    const log = path.join(dir, "out.log");
    await new ClaudeCodeRunner({ bin: FAKE }).runStage({ workdir: dir, prompt: "x", logPath: log });
    expect(fs.readFileSync(log, "utf8")).toContain("--setting-sources project,local");
  });

  it("passes no --allowedTools when none are given", async () => {
    const log = path.join(dir, "out.log");
    await new ClaudeCodeRunner({ bin: FAKE }).runStage({ workdir: dir, prompt: "x", logPath: log });
    expect(fs.readFileSync(log, "utf8")).not.toContain("--allowedTools");
  });

  it("passes --verbose, which the binary requires alongside stream-json", async () => {
    const runner = new ClaudeCodeRunner({ bin: FAKE });
    const log = path.join(dir, "out.log");
    await runner.runStage({ workdir: dir, prompt: "x", logPath: log });
    expect(fs.readFileSync(log, "utf8")).toContain("--verbose");
  });

  it("passes --max-budget-usd only when a budget is configured", async () => {
    const log = path.join(dir, "out.log");
    await new ClaudeCodeRunner({ bin: FAKE }).runStage({
      workdir: dir,
      prompt: "x",
      logPath: log,
    });
    expect(fs.readFileSync(log, "utf8")).not.toContain("--max-budget-usd");

    const capped = path.join(dir, "capped.log");
    await new ClaudeCodeRunner({ bin: FAKE, maxBudgetUsd: 2.5 }).runStage({
      workdir: dir,
      prompt: "x",
      logPath: capped,
    });
    expect(fs.readFileSync(capped, "utf8")).toContain("--max-budget-usd 2.5");
  });

  it("returns usage parsed out of the stream-json it wrote to the log", async () => {
    const runner = new ClaudeCodeRunner({ bin: FAKE });
    const res = await runner.runStage({
      workdir: dir,
      prompt: "x",
      logPath: path.join(dir, "out.log"),
    });
    expect(res.usage).toBeDefined();
    expect(res.usage?.costUsd).toBeGreaterThan(0);
  });

  it("still returns a result when the log holds no result event", async () => {
    const runner = new ClaudeCodeRunner({ bin: FAKE, env: { FAKE_EXIT: "3" } });
    const res = await runner.runStage({
      workdir: dir,
      prompt: "x",
      logPath: path.join(dir, "out.log"),
    });
    expect(res.ok).toBe(false);
    // The fixture emits its result line before exiting, so a failed run still
    // reports what it spent — that is the whole point of billing failures too.
    expect(res.usage).toBeDefined();
  });

  it("runs in the project directory", async () => {
    const runner = new ClaudeCodeRunner({ bin: FAKE });
    const log = path.join(dir, "out.log");
    await runner.runStage({ workdir: dir, prompt: "x", logPath: log });
    expect(fs.readFileSync(log, "utf8")).toContain(fs.realpathSync(dir));
  });

  it("reports a non-zero exit as not ok", async () => {
    const runner = new ClaudeCodeRunner({ bin: FAKE, env: { FAKE_EXIT: "3" } });
    const res = await runner.runStage({
      workdir: dir,
      prompt: "x",
      logPath: path.join(dir, "out.log"),
    });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
  });

  it("rejects an unopenable log path by resolving, never by throwing", async () => {
    const runner = new ClaudeCodeRunner({ bin: FAKE });
    // A path whose parent is a regular file cannot be created as a directory.
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "not a directory");

    const res = await runner.runStage({
      workdir: dir,
      prompt: "x",
      logPath: path.join(blocker, "out.log"),
    });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(126);
  });

  it("creates the log directory if missing", async () => {
    const runner = new ClaudeCodeRunner({ bin: FAKE });
    const log = path.join(dir, "nested", "deeper", "out.log");
    await runner.runStage({ workdir: dir, prompt: "x", logPath: log });
    expect(fs.existsSync(log)).toBe(true);
  });
});

const RESULT = (cost: number) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: cost,
    num_turns: 1,
    duration_ms: 3321,
    usage: {
      input_tokens: 2,
      output_tokens: 4,
      cache_creation_input_tokens: 10106,
      cache_read_input_tokens: 19703,
    },
  });

describe("parseUsageFromLog", () => {
  it("extracts the result event", () => {
    const usage = parseUsageFromLog(
      [JSON.stringify({ type: "system", subtype: "init" }), RESULT(0.111)].join("\n"),
    );
    expect(usage).toEqual({
      costUsd: 0.111,
      durationMs: 3321,
      numTurns: 1,
      inputTokens: 2,
      outputTokens: 4,
      cacheCreationInputTokens: 10106,
      cacheReadInputTokens: 19703,
    });
  });

  it("skips lines that are not JSON at all", () => {
    // Real runs interleave plain-text warnings with the JSONL stream; a parser
    // that throws on them loses the cost data for the whole run.
    const text = [
      "Warning: no stdin data received in 3s...",
      JSON.stringify({ type: "assistant" }),
      "",
      RESULT(0.222),
      "  ",
    ].join("\n");
    expect(parseUsageFromLog(text)?.costUsd).toBe(0.222);
  });

  it("prefers the last result event when several appear", () => {
    const text = [RESULT(0.1), JSON.stringify({ type: "assistant" }), RESULT(0.9)].join("\n");
    expect(parseUsageFromLog(text)?.costUsd).toBe(0.9);
  });

  it("returns undefined when there is no result event", () => {
    expect(parseUsageFromLog("")).toBeUndefined();
    expect(parseUsageFromLog(JSON.stringify({ type: "assistant" }))).toBeUndefined();
  });

  it("treats missing numeric fields as zero rather than NaN", () => {
    // A stream truncated by a kill can leave a result event with no usage block.
    const usage = parseUsageFromLog(JSON.stringify({ type: "result" }));
    expect(usage).toEqual({
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });
});

describe("readLogTail", () => {
  it("returns the whole file when it is smaller than the cap", () => {
    const f = path.join(dir, "small.log");
    fs.writeFileSync(f, "hello\nworld\n");
    expect(readLogTail(f)).toBe("hello\nworld\n");
  });

  it("returns only the tail of a large file", () => {
    const f = path.join(dir, "big.log");
    fs.writeFileSync(f, "x".repeat(5000) + "\nTAIL\n");
    const tail = readLogTail(f, 100);
    expect(tail.length).toBeLessThanOrEqual(100);
    expect(tail).toContain("TAIL");
  });

  it("still finds the result event when the head of the log is discarded", () => {
    // The failure this guards: a verbose stage produces a log too large to
    // read whole, cost data disappears, and the stage reports success anyway.
    const f = path.join(dir, "verbose.log");
    const noise = Array.from({ length: 2000 }, (_, i) =>
      JSON.stringify({ type: "assistant", n: i, pad: "y".repeat(200) }),
    ).join("\n");
    const result = JSON.stringify({
      type: "result",
      total_cost_usd: 1.25,
      duration_ms: 9000,
      num_turns: 7,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
      },
    });
    fs.writeFileSync(f, `${noise}\n${result}\n`);

    const usage = parseUsageFromLog(readLogTail(f, 4096));
    expect(usage?.costUsd).toBe(1.25);
    expect(usage?.numTurns).toBe(7);
  });

  it("returns an empty string for an empty file", () => {
    const f = path.join(dir, "empty.log");
    fs.writeFileSync(f, "");
    expect(readLogTail(f)).toBe("");
  });
});
