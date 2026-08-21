import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Runner, RunStageInput, StageResult } from "./types.js";

export const DEFAULT_MODEL = "claude-opus-5";

export interface ClaudeCodeRunnerOptions {
  bin?: string;
  env?: Record<string, string>;
}

export class ClaudeCodeRunner implements Runner {
  private readonly bin: string;
  private readonly extraEnv: Record<string, string>;

  constructor(opts: ClaudeCodeRunnerOptions = {}) {
    this.bin = opts.bin ?? "claude";
    this.extraEnv = opts.env ?? {};
  }

  runStage(input: RunStageInput): Promise<StageResult> {
    fs.mkdirSync(path.dirname(input.logPath), { recursive: true });
    const log = fs.openSync(input.logPath, "a");

    const args = [
      "--print",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--model",
      input.model ?? DEFAULT_MODEL,
      input.prompt,
    ];

    return new Promise((resolve) => {
      const child = spawn(this.bin, args, {
        cwd: input.workdir,
        env: { ...process.env, ...this.extraEnv },
        stdio: ["ignore", log, log],
      });

      child.on("close", (code) => {
        fs.closeSync(log);
        const exitCode = code ?? 1;
        resolve({ ok: exitCode === 0, exitCode, logPath: input.logPath });
      });

      child.on("error", () => {
        fs.closeSync(log);
        resolve({ ok: false, exitCode: 127, logPath: input.logPath });
      });
    });
  }
}
