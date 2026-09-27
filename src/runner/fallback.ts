import type { Runner, RunStageInput, StageResult } from "./types.js";

/**
 * Runs on the plan until a usage limit stops a stage, then repeats that stage
 * on the API key and stays there for the rest of the run. Opt-in only: the
 * switch turns plan usage into billed money, which is the person's call.
 *
 * The interrupted attempt spent real usage, and the orchestrator only ever
 * sees the result it is handed, so that attempt goes to `onAbandoned` for the
 * caller to put on the bill.
 */
export class FallbackRunner implements Runner {
  private switched = false;

  constructor(
    private readonly plan: Runner,
    private readonly apiKey: Runner,
    private readonly onAbandoned: (input: RunStageInput, result: StageResult) => void,
    private readonly log: (message: string) => void = console.error,
  ) {}

  async runStage(input: RunStageInput): Promise<StageResult> {
    if (!this.switched) {
      const result = await this.plan.runStage(input);
      if (!result.limited) return result;
      this.onAbandoned(input, result);
      this.switched = true;
      const when = result.limited.resetsAt ? ` (resets ${result.limited.resetsAt})` : "";
      this.log(`sfo: plan limit reached${when} — continuing on your API key, which is billed`);
    }
    return this.apiKey.runStage(input);
  }
}
