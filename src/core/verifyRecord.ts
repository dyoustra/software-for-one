import { z } from "zod";
import { artifactPath, type Env } from "./paths.js";
import { readRecords, appendRecord } from "./jsonl.js";

/**
 * One slice attempt, as the gate saw it.
 *
 * This is the only structured account of what verification did. The
 * per-attempt `.sfo/logs/build-<slice>.verify.log` is unstructured and
 * gitignored, so the deliver stage — the one stage required to lead with what
 * does not work — has nothing else to read.
 */
export const VerifyRecordSchema = z
  .object({
    slice: z.string().min(1),
    /** 1 for the first attempt at this slice. */
    attempt: z.number().int().positive(),
    ok: z.boolean(),
    /** The archetype whose recipe was used — which gates existed at all. */
    archetype: z.string().min(1),
    /** The step that failed. Absent when the gate never reached a step. */
    failedStep: z.string().min(1).optional(),
    /** Why it failed, when no step reports it. */
    reason: z.string().min(1).optional(),
    /** Test paths that no longer matched the lock. Non-empty means no step ran. */
    tamperedTests: z.array(z.string()),
    /**
     * Why the gate ran, when it was not an attempt at building the slice: a
     * test amended after the lock re-grades every slice that had passed.
     */
    trigger: z.enum(["relock"]).optional(),
    at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
      message: "at must be a parseable timestamp",
    }),
  })
  // A failure that says nothing about why is worse than no record: deliver
  // would report a failed slice with no cause, which reads as a tooling bug
  // rather than as the gate doing its job.
  .refine((r) => r.ok || r.failedStep !== undefined || r.reason !== undefined, {
    message: "a failed attempt must name the step that failed or the reason it failed",
  })
  .refine((r) => !r.ok || r.failedStep === undefined, {
    message: "a passing attempt cannot have a failed step",
  });

export type VerifyRecord = z.infer<typeof VerifyRecordSchema>;

export const VERIFY_FILE = "VERIFY.jsonl";

export function readVerifyRecords(id: string, env?: Env): VerifyRecord[] {
  return readRecords(artifactPath(id, VERIFY_FILE, env), VerifyRecordSchema);
}

/** Append-only: the second attempt's failure is rarely the first one's. */
export function appendVerifyRecord(id: string, record: VerifyRecord, env?: Env): void {
  appendRecord(artifactPath(id, VERIFY_FILE, env), VerifyRecordSchema, record);
}
