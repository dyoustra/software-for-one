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
      // Opening the log must happen inside the executor. Done above it, a
      // bad logPath throws synchronously out of runStage — which contradicts
      // the Promise<StageResult> signature and would strand a project as
      // `running` when the orchestrator's await rejects mid-advance.
      let log: number;
      try {
        fs.mkdirSync(path.dirname(input.logPath), { recursive: true });
        log = fs.openSync(input.logPath, "a");
      } catch {
        // 126: failed before we could exec anything.
        resolve({ ok: false, exitCode: 126, logPath: input.logPath });
        return;
      }

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
