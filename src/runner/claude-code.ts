import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Runner, RunStageInput, StageResult, StageUsage } from "./types.js";

export const DEFAULT_MODEL = "claude-opus-5";

export interface ClaudeCodeRunnerOptions {
  bin?: string;
  env?: Record<string, string>;
  /** Hard per-invocation spend cap, passed through as `--max-budget-usd`. */
  maxBudgetUsd?: number;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Pulls the spend out of a stream-json log.
 *
 * Two things make this laxer than a normal parser. The stream is JSONL but
 * carries plain-text lines too (`Warning: no stdin data received in 3s...`),
 * so an unparseable line is skipped rather than fatal. And a run can emit more
 * than one result event, of which only the last describes the finished
 * invocation — so this keeps scanning instead of returning on the first hit.
 */
export function parseUsageFromLog(text: string): StageUsage | undefined {
  let last: Record<string, unknown> | undefined;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed[0] !== "{") continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj?.type === "result") last = obj;
    } catch {
      // Not JSON. Cost data is worth more than strictness here.
    }
  }

  if (!last) return undefined;
  const usage = (last.usage ?? {}) as Record<string, unknown>;
  return {
    costUsd: num(last.total_cost_usd),
    durationMs: num(last.duration_ms),
    numTurns: num(last.num_turns),
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheCreationInputTokens: num(usage.cache_creation_input_tokens),
    cacheReadInputTokens: num(usage.cache_read_input_tokens),
  };
}

/**
 * Only the tail is needed — the result event is always the last line — and
 * reading the whole file is a trap. stream-json is far more verbose than the
 * old `json` format, so a long stage with many tool calls can produce a log
 * large enough to exceed V8's string cap. That throws, usage silently becomes
 * undefined, and the cost data vanishes for exactly the expensive stages you
 * most wanted to measure.
 *
 * Slicing at a byte offset can cut a UTF-8 sequence or a line in half; that is
 * harmless because parseUsageFromLog skips anything it cannot parse.
 */
const LOG_TAIL_BYTES = 512 * 1024;

export function readLogTail(logPath: string, maxBytes = LOG_TAIL_BYTES): string {
  const { size } = fs.statSync(logPath);
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  if (length === 0) return "";

  const fd = fs.openSync(logPath, "r");
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function readUsage(logPath: string): StageUsage | undefined {
  try {
    return parseUsageFromLog(readLogTail(logPath));
  } catch {
    // No log, or it vanished. Missing cost data must never fail a stage.
    return undefined;
  }
}

export class ClaudeCodeRunner implements Runner {
  private readonly bin: string;
  private readonly extraEnv: Record<string, string>;
  private readonly maxBudgetUsd?: number;

  constructor(opts: ClaudeCodeRunnerOptions = {}) {
    this.bin = opts.bin ?? "claude";
    this.extraEnv = opts.env ?? {};
    // Env var so every call site (sfo run, sfo stage, the detached child)
    // inherits the same ceiling without threading an option through each one.
    const fromEnv = Number(process.env.SFO_MAX_BUDGET_USD);
    this.maxBudgetUsd = opts.maxBudgetUsd ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : undefined);
  }

  runStage(input: RunStageInput): Promise<StageResult> {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      // Not optional: the binary refuses stream-json under --print without it.
      "--verbose",
      // User settings excluded: a stage runs unattended, and the user's own
      // allowlist is written for sessions they watch. On the machine sfo was
      // built on it allowed python3, xargs (which runs anything) and `gh api`
      // (writes to GitHub as the user), and every stage inherited them. What a
      // stage may run is decided by sfo, per stage, in --allowedTools.
      "--setting-sources",
      "project,local",
      "--permission-mode",
      "acceptEdits",
      // Variadic, so it must be followed by another flag: placed last, it
      // would swallow the prompt as one more tool name.
      ...(input.allowedTools?.length ? ["--allowedTools", ...input.allowedTools] : []),
      "--model",
      input.model ?? DEFAULT_MODEL,
    ];
    if (this.maxBudgetUsd !== undefined) {
      args.push("--max-budget-usd", String(this.maxBudgetUsd));
    }
    args.push(input.prompt);

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
        resolve({
          ok: exitCode === 0,
          exitCode,
          logPath: input.logPath,
          // The log is the transport: stream-json is still piped straight to
          // the file so `sfo logs -f` shows live progress, and we read the
          // spend back out once the process has closed it.
          usage: readUsage(input.logPath),
        });
      });

      child.on("error", () => {
        fs.closeSync(log);
        resolve({ ok: false, exitCode: 127, logPath: input.logPath });
      });
    });
  }
}
