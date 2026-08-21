import { z } from "zod";
import { artifactPath, type Env } from "./paths.js";
import { readRecords, appendRecord } from "./jsonl.js";

export const DecisionSchema = z.object({
  id: z.string().min(1),
  decision: z.string().min(1),
  chose: z.string().min(1),
  considered: z.string(),
  why: z.string().min(1),
  /**
   * Required. Writing it only for human overrides makes absence load-bearing,
   * and absence cannot be distinguished from a bug or a prompt-version skew.
   */
  decided_by: z.enum(["agent", "human"]),
  blast_radius: z.enum(["local", "structural", "external"]),
  at: z.string(),
});

export type Decision = z.infer<typeof DecisionSchema>;

export const DECISIONS_FILE = "DECISIONS.jsonl";

export function readDecisions(id: string, env?: Env): Decision[] {
  return readRecords(artifactPath(id, DECISIONS_FILE, env), DecisionSchema);
}

export function appendDecision(id: string, decision: Decision, env?: Env): void {
  appendRecord(artifactPath(id, DECISIONS_FILE, env), DecisionSchema, decision);
}
