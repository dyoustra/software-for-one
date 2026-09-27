import { spawn } from "node:child_process";
import os from "node:os";
import type { StageUsage } from "./types.js";
import { DEFAULT_MODEL } from "./claude-code.js";

export interface StructuredRunOptions {
  prompt: string;
  schema: Record<string, unknown>;
  bin?: string;
  model?: string;
  /** Hard per-invocation spend cap, passed through as `--max-budget-usd`. */
  maxBudgetUsd?: number;
  cwd?: string;
  /** The child's environment; defaults to this process's. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export interface StructuredRunResult {
  /** The inner `result` string, still un-parsed. */
  text: string;
  usage?: StageUsage;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function excerpt(text: string, max = 200): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * `--output-format json` wraps the model's answer in an envelope whose
 * `result` field is a STRING of JSON, not a nested object. Returning it
 * un-parsed keeps the second parse — and any schema validation — with the
 * caller that knows what shape it asked for.
 */
export function parseStructuredOutput(stdout: string): StructuredRunResult {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`claude returned output that is not JSON: ${excerpt(stdout)}`);
  }

  if (payload.is_error === true) {
    const message = typeof payload.result === "string" ? payload.result : excerpt(stdout);
    throw new Error(`claude reported an error: ${message}`);
  }

  if (typeof payload.result !== "string") {
    throw new Error(`claude returned no result string: ${excerpt(stdout)}`);
  }

  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  return {
    text: payload.result,
    usage: {
      costUsd: num(payload.total_cost_usd),
      durationMs: num(payload.duration_ms),
      numTurns: num(payload.num_turns),
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheCreationInputTokens: num(usage.cache_creation_input_tokens),
      cacheReadInputTokens: num(usage.cache_read_input_tokens),
    },
  };
}

/**
 * One-shot structured-output call to the `claude` CLI.
 *
 * Deliberately not part of `Runner`: `runStage` runs a stage inside a
 * project working directory, and this runs before any project exists.
 *
 * Shelling out rather than using the SDK is what keeps the whole pipeline on
 * a single credential — the CLI's own OAuth token — instead of also needing
 * an ANTHROPIC_API_KEY for this one call.
 */
export function runStructured(opts: StructuredRunOptions): Promise<StructuredRunResult> {
  const args = [
    "--print",
    "--output-format",
    "json",
    "--model",
    opts.model ?? DEFAULT_MODEL,
    "--json-schema",
    JSON.stringify(opts.schema),
  ];

  const fromEnv = Number(process.env.SFO_MAX_BUDGET_USD);
  const maxBudgetUsd =
    opts.maxBudgetUsd ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : undefined);
  if (maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(maxBudgetUsd));
  }
  args.push(opts.prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(opts.bin ?? "claude", args, {
      // Triage has no project directory. Running in the repo root would let
      // CLAUDE.md discovery pull unrelated project context into the prompt.
      cwd: opts.cwd ?? os.tmpdir(),
      env: opts.env ?? process.env,
      // stdin must be closed: left open, the binary waits 3s for input and
      // prints a warning into the output we are about to parse.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(new Error(`failed to run ${opts.bin ?? "claude"}: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code ?? 1}: ${excerpt(stderr || stdout)}`));
        return;
      }
      try {
        resolve(parseStructuredOutput(stdout));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
