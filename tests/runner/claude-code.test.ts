import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeRunner } from "../../src/runner/claude-code.js";

const FAKE = path.resolve("tests/fixtures/fake-claude.sh");
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-run-"));
});

describe("ClaudeCodeRunner", () => {
  it("passes print mode, json output, and the model", async () => {
    const runner = new ClaudeCodeRunner({ bin: FAKE });
    const log = path.join(dir, "out.log");
    const res = await runner.runStage({ workdir: dir, prompt: "hello", logPath: log });

    expect(res.ok).toBe(true);
    const out = fs.readFileSync(log, "utf8");
    expect(out).toContain("--print");
    expect(out).toContain("--output-format json");
    expect(out).toContain("claude-opus-5");
    expect(out).toContain("hello");
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

  it("creates the log directory if missing", async () => {
    const runner = new ClaudeCodeRunner({ bin: FAKE });
    const log = path.join(dir, "nested", "deeper", "out.log");
    await runner.runStage({ workdir: dir, prompt: "x", logPath: log });
    expect(fs.existsSync(log)).toBe(true);
  });
});
