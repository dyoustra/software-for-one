import fs from "node:fs";
import { z } from "zod";
import { artifactPath, sfoDir, type Env } from "./paths.js";

export const STALE_AFTER_MS = 120_000;

export const ProjectStateSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  currentStage: z.string(),
  status: z.enum(["running", "awaiting_human", "failed", "done"]),
  /** Retries per stage, keyed by stage name. */
  attempts: z.record(z.string(), z.number()),
  /**
   * Retries per build slice, keyed by slice id. A separate dictionary rather
   * than more keys in `attempts`: two key spaces sharing one record have
   * nothing marking the boundary, so `attempts["S-01"]` reads as a stage named
   * S-01 to every consumer, and the day a stage and a slice share a name one
   * silently overwrites the other. `.default({})` makes the split free — every
   * state.json written before this field parses with an empty one.
   */
  sliceAttempts: z.record(z.string(), z.number()).default({}),
  slicesPassed: z.array(z.string()).default([]),
  slicesFailed: z.array(z.string()).default([]),
  pid: z.number().nullable(),
  heartbeatAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProjectState = z.infer<typeof ProjectStateSchema>;

/**
 * What a caller must supply: the defaulted fields are optional here, so code
 * written before they existed still compiles and still produces a complete
 * file, because `writeState` fills them in.
 */
export type ProjectStateInput = z.input<typeof ProjectStateSchema>;

export function writeState(state: ProjectStateInput, env?: Env): void {
  // Parsed rather than written through, so defaults land on disk instead of
  // being re-applied on every read. A state.json missing half its fields is
  // readable but tells `sfo status` nothing.
  const complete = ProjectStateSchema.parse(state);
  const target = artifactPath(complete.id, "state.json", env);
  const tmp = `${target}.tmp`;
  fs.mkdirSync(sfoDir(complete.id, env), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(complete, null, 2));
  fs.renameSync(tmp, target);
}

export function readState(id: string, env?: Env): ProjectState {
  const file = artifactPath(id, "state.json", env);
  if (!fs.existsSync(file)) {
    throw new Error(`no such project: ${id}`);
  }
  const raw = fs.readFileSync(file, "utf8");
  const parsed = ProjectStateSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`invalid state for project ${id}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * A project marked `running` whose heartbeat has gone quiet was killed without
 * getting to update its own state. There is no other way to distinguish that
 * from a live run, so the heartbeat is what makes `sfo run` safe to resume.
 */
export function isStale(state: ProjectState, now: Date = new Date()): boolean {
  if (state.status !== "running") return false;
  if (!state.heartbeatAt) return true;
  return now.getTime() - new Date(state.heartbeatAt).getTime() > STALE_AFTER_MS;
}
