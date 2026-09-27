export interface RunStageInput {
  workdir: string;
  prompt: string;
  logPath: string;
  model?: string;
  /** `--allowedTools` patterns. Absent means edits only: every command is denied. */
  allowedTools?: string[];
}

/** What one `claude -p` invocation cost, as reported by its own result event. */
export interface StageUsage {
  costUsd: number;
  durationMs: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface StageResult {
  ok: boolean;
  exitCode: number;
  logPath: string;
  /** Absent when the process died before emitting a result event. */
  usage?: StageUsage;
  /** Whether the spend was billed or came out of plan limits; absent when unknown. */
  billing?: "api" | "plan";
  /** Set when the run stopped because a subscription's usage limit was hit. */
  limited?: UsageLimit;
}

export interface UsageLimit {
  /** ISO time the limit lifts, when the CLI said. */
  resetsAt?: string;
  /** Which window ran out, e.g. `five_hour` or `seven_day`. */
  window?: string;
}

export interface Runner {
  runStage(input: RunStageInput): Promise<StageResult>;
}
