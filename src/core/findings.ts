import { z } from "zod";
import { artifactPath, type Env } from "./paths.js";
import { readRecords, writeRecords } from "./jsonl.js";

export const FINDINGS_FILE = "FINDINGS.jsonl";

/** Where a reviewer's reproduction tests go: inside the suite, so they are locked with it. */
export const REVIEW_TEST_DIR = "tests/review";

export const FINDING_STATUSES = [
  "open",
  "repaired",
  "unrepaired",
  "not_reproduced",
  "report_only",
  "dropped",
] as const;

export const FindingSchema = z.object({
  id: z.string().regex(/^R-\d+$/, "R- followed by digits"),
  round: z.union([z.literal(1), z.literal(2)]),
  severity: z.enum(["high", "medium", "low"]),
  kind: z.enum(["code", "coverage", "spec", "seam", "safety"]),
  criterionId: z.string().min(1).nullable().default(null),
  decisionId: z.string().min(1).nullable().default(null),
  summary: z.string().min(1),
  evidence: z.string(),
  test: z.string().min(1).nullable().default(null),
  status: z.enum(FINDING_STATUSES).default("open"),
  /** Why the pipeline set the status it did, when that is not self-evident. */
  statusWhy: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export function readFindings(id: string, env?: Env): Finding[] {
  return readRecords(artifactPath(id, FINDINGS_FILE, env), FindingSchema);
}

export function writeFindings(id: string, findings: Finding[], env?: Env): void {
  writeRecords(artifactPath(id, FINDINGS_FILE, env), FindingSchema, findings);
}

/**
 * Only these send the project back to build: hollow or wrong against a
 * criterion, and serious. Whether one came with the test that proves it is a
 * separate question, answered by marking it unrepaired rather than quietly
 * demoting it to a report.
 */
export function isRepairable(f: Finding): boolean {
  return f.round === 1 && f.severity === "high" && f.kind === "code";
}
