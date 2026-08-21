export interface RunStageInput {
  workdir: string;
  prompt: string;
  logPath: string;
  model?: string;
}

export interface StageResult {
  ok: boolean;
  exitCode: number;
  logPath: string;
}

export interface Runner {
  runStage(input: RunStageInput): Promise<StageResult>;
}
