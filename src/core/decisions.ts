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
  decided_by: z.enum(["agent", "human", "adjudicator"]),
  blast_radius: z.enum(["local", "structural", "external"]),
  /**
   * Validated as a real timestamp, not just a string. The review UI sorts and
   * displays by this; an unparseable value would fail silently there rather
   * than at the point it was written.
   */
  at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
    message: "at must be a parseable timestamp",
  }),
});

export type Decision = z.infer<typeof DecisionSchema>;

export const DECISIONS_FILE = "DECISIONS.jsonl";

export function readDecisions(id: string, env?: Env): Decision[] {
  return readRecords(artifactPath(id, DECISIONS_FILE, env), DecisionSchema);
}

export function appendDecision(id: string, decision: Decision, env?: Env): void {
  appendRecord(artifactPath(id, DECISIONS_FILE, env), DecisionSchema, decision);
}
