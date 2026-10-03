import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Runner, RunStageInput, StageResult, StageUsage, UsageLimit } from "./types.js";
import { billingFor, childEnv, type Billing, type ResolvedAccess } from "../core/access.js";

export interface ClaudeCodeRunnerOptions {
  bin?: string;
  env?: Record<string, string>;
  /** Hard per-invocation spend cap, passed through as `--max-budget-usd`. */
  maxBudgetUsd?: number;
  /** Which credential the child runs on. Absent means whatever the shell has. */
  access?: ResolvedAccess;
  /** What bounds a stage. Defaults to `SFO_CONFINEMENT`, else "sandbox". */
  confinement?: Confinement;
}

/**
 * What keeps a stage from changing anything outside its project.
 * - sandbox: Claude Code's Bash sandbox, on a machine the person uses.
 * - vm: the machine itself is disposable and holds one run (a Sprite), so no
 *   command waits for an approval nobody is there to give.
 * - none: neither, for tests and debugging.
 */
export type Confinement = "sandbox" | "vm" | "none";

function confinementFrom(value: string | undefined): Confinement {
  if (value === undefined || value === "" || value === "sandbox") return "sandbox";
  if (value === "vm" || value === "none") return value;
  throw new Error(`SFO_CONFINEMENT must be sandbox, vm or none, not "${value}"`);
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

const LIMIT_TEXT = /usage limit reached|hit your limit/i;

/**
 * Whether a failed run was stopped by a subscription limit. The stream carries
 * `rate_limit_event` messages whose `status` turns `rejected` when a window is
 * exhausted; the text match is for a run that died before one was emitted.
 * Checked only on a failed run: a warning mid-run that the run survived is not
 * a reason to stop.
 */
export function parseUsageLimitFromLog(text: string): UsageLimit | undefined {
  let info: Record<string, unknown> | undefined;
  let resultText = "";

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed[0] !== "{") continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj?.type === "rate_limit_event") info = obj.rate_limit_info as Record<string, unknown>;
      if (obj?.type === "result" && typeof obj.result === "string") resultText = obj.result;
    } catch {
      // Not JSON.
    }
  }

  const rejected = info?.status === "rejected";
  if (!rejected && !LIMIT_TEXT.test(resultText)) return undefined;
  const resetsAt = rejected && typeof info?.resetsAt === "number" ? info.resetsAt : undefined;
  const window = rejected && typeof info?.rateLimitType === "string" ? info.rateLimitType : undefined;
  return {
    ...(resetsAt !== undefined ? { resetsAt: new Date(resetsAt * 1000).toISOString() } : {}),
    ...(window !== undefined ? { window } : {}),
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

function readTail(logPath: string): string {
  try {
    return readLogTail(logPath);
  } catch {
    // No log, or it vanished. Missing cost data must never fail a stage.
    return "";
  }
}

/**
 * Claude Code's own Bash sandbox, so stages can run any command, chained or
 * piped, and still not change anything outside the project.
 *
 * The allowlist this replaces was the wrong guard: it refused `cd /tmp &&
 * curl …` (twelve times in one research stage) while already permitting
 * `uv run python -c …`, which can delete anything. The sandbox bounds what a
 * command can *do*, whatever it is called. Writes: the project, the temp
 * directories, and the package managers' caches. Network: open, since
 * research and installs need it and reading the web is not destructive.
 * No unsandboxed retries, and no running at all where the sandbox is
 * unavailable: a stage that cannot be confined fails instead.
 */
export const SANDBOX_SETTINGS = {
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: [
        "/tmp",
        "/private/tmp",
        "~/.cache/uv",
        "~/.local/share/uv",
        "~/.cache/pip",
        "~/Library/Caches/pip",
        "~/.npm",
      ],
    },
    // Mach lookups reach system services, not files. uv reads the system
    // proxy through one at startup and panics without it, on every command.
    network: { allowedDomains: ["*"], allowMachLookup: true },
  },
};

export class ClaudeCodeRunner implements Runner {
  private readonly bin: string;
  private readonly extraEnv: Record<string, string>;
  private readonly maxBudgetUsd?: number;
  private readonly access: ResolvedAccess;
  private readonly billing: Billing | undefined;
  private readonly confinement: Confinement;

  constructor(opts: ClaudeCodeRunnerOptions = {}) {
    this.bin = opts.bin ?? "claude";
    this.extraEnv = opts.env ?? {};
    this.access = opts.access ?? { method: "inherit" };
    this.billing = billingFor(this.access, process.env);
    this.confinement = opts.confinement ?? confinementFrom(process.env.SFO_CONFINEMENT);
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
      // Variadic, so it must be followed by a flag that is always passed:
      // anywhere later, it would swallow the prompt as one more tool name.
      ...(input.allowedTools?.length ? ["--allowedTools", ...input.allowedTools] : []),
      "--setting-sources",
      "project,local",
      "--permission-mode",
      // Outside a VM, bypassPermissions also lets Bash and Write change files
      // anywhere in the person's home, sandbox or not: a probe wrote to ~.
      this.confinement === "vm" ? "bypassPermissions" : "acceptEdits",
      ...(this.confinement === "sandbox" ? ["--settings", JSON.stringify(SANDBOX_SETTINGS)] : []),
      // No model named means Claude Code's own default, which moves with it.
      ...(input.model ? ["--model", input.model] : []),
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
        env: { ...childEnv(process.env, this.access), ...this.extraEnv },
        stdio: ["ignore", log, log],
      });

      child.on("close", (code) => {
        fs.closeSync(log);
        const exitCode = code ?? 1;
        // The log is the transport: stream-json is still piped straight to
        // the file so `sfo logs -f` shows live progress, and we read the
        // spend back out once the process has closed it.
        const tail = readTail(input.logPath);
        const usage = parseUsageFromLog(tail);
        const limited = exitCode !== 0 ? parseUsageLimitFromLog(tail) : undefined;
        resolve({
          ok: exitCode === 0,
          exitCode,
          logPath: input.logPath,
          ...(usage ? { usage } : {}),
          billing: this.billing,
          ...(limited ? { limited } : {}),
        });
      });

      child.on("error", () => {
        fs.closeSync(log);
        resolve({ ok: false, exitCode: 127, logPath: input.logPath });
      });
    });
  }
}
