import { z } from "zod";
import { artifactPath, type Env } from "./paths.js";
import { readRecords, appendRecord } from "./jsonl.js";

export const EstimateSchema = z
  .object({
    phase: z.enum(["front", "build"]),
    lowUsd: z.number().nonnegative(),
    highUsd: z.number().nonnegative(),
    basis: z.string().min(1),
    at: z.string(),
  })
  .refine((e) => e.lowUsd <= e.highUsd, { message: "lowUsd must not exceed highUsd" });

export type Estimate = z.infer<typeof EstimateSchema>;
export const ESTIMATE_FILE = "ESTIMATE.jsonl";

export function readEstimate(id: string, env?: Env): Estimate[] {
  return readRecords(artifactPath(id, ESTIMATE_FILE, env), EstimateSchema);
}

/** Appends: the rough and precise estimates are both worth keeping. */
export function writeEstimate(id: string, estimate: Estimate, env?: Env): void {
  appendRecord(artifactPath(id, ESTIMATE_FILE, env), EstimateSchema, estimate);
}

export function formatEstimate(e: Estimate): string {
  return `estimated ${e.phase}: $${e.lowUsd}–$${e.highUsd} — ${e.basis}`;
}
