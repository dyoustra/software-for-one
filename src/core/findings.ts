import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { artifactPath, sfoDir, type Env } from "./paths.js";
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
  "rolled_back",
] as const;

export const FindingSchema = z.object({
  id: z.string().regex(/^R-\d+$/, "R- followed by digits"),
  round: z.union([z.literal(1), z.literal(2)]),
  severity: z.enum(["high", "medium", "low"]),
  kind: z.enum(["code", "coverage", "spec", "seam", "safety", "test"]),
  criterionId: z.string().min(1).nullable().default(null),
  decisionId: z.string().min(1).nullable().default(null),
  summary: z.string().min(1),
  evidence: z.string(),
  test: z.string().min(1).nullable().default(null),
  /** `kind: "test"` only: the test or helper that is itself wrong. */
  testFile: z.string().min(1).nullable().default(null),
  /** Round 2 only: the repaired finding whose repair introduced this one. */
  causedBy: z.string().nullable().default(null),
  /** The commit whose repair made this finding's test pass. */
  repairCommit: z.string().optional(),
  status: z.enum(FINDING_STATUSES).default("open"),
  /** Why the pipeline set the status it did, when that is not self-evident. */
  statusWhy: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export function readFindings(id: string, env?: Env): Finding[] {
  return readRecords(artifactPath(id, FINDINGS_FILE, env), FindingSchema);
}

/**
 * Every finding that parses, and the lines that did not. One bad field used to
 * fail the whole file, and the fallback then wrote it back empty: a review of
 * ut-tower numbered its findings round 3, and all ten of them were lost.
 */
export function readFindingsLenient(id: string, env?: Env): { findings: Finding[]; rejected: string[] } {
  const file = artifactPath(id, FINDINGS_FILE, env);
  if (!fs.existsSync(file)) return { findings: [], rejected: [] };
  const findings: Finding[] = [];
  const rejected: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = FindingSchema.safeParse(JSON.parse(line));
      if (parsed.success) findings.push(parsed.data);
      else rejected.push(`${line.slice(0, 80)} — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    } catch {
      rejected.push(`${line.slice(0, 80)} — not JSON`);
    }
  }
  if (rejected.length > 0) {
    // Kept as written, so nothing a reviewer paid for is lost to a bad field.
    fs.copyFileSync(file, artifactPath(id, `FINDINGS.rejected-${Date.now()}.jsonl`, env));
  }
  return { findings, rejected };
}

export const FINDINGS_HISTORY_DIR = "findings-history";

/**
 * Starts a new review with an empty file, keeping the last one. A second full
 * review that sees the first one's findings continues their numbering, and
 * rounds past 2 are not a thing this pipeline has.
 */
export function archiveFindings(id: string, env?: Env): string | null {
  const file = artifactPath(id, FINDINGS_FILE, env);
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8").trim() === "") return null;
  const dir = path.join(sfoDir(id, env), FINDINGS_HISTORY_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `findings-${fs.readdirSync(dir).length + 1}.jsonl`);
  fs.renameSync(file, target);
  return target;
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
/** At most this many `test` findings go to the adjudicator per review. */
export const MAX_TEST_ADJUDICATIONS = 3;

export function isRepairable(f: Finding): boolean {
  return f.round === 1 && f.severity === "high" && f.kind === "code";
}
