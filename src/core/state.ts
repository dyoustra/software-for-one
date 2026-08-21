import fs from "node:fs";
import { z } from "zod";
import { artifactPath, sfoDir, type Env } from "./paths.js";

export const STALE_AFTER_MS = 120_000;

export const ProjectStateSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  currentStage: z.string(),
  status: z.enum(["running", "awaiting_human", "failed", "done"]),
  attempts: z.record(z.string(), z.number()),
  pid: z.number().nullable(),
  heartbeatAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProjectState = z.infer<typeof ProjectStateSchema>;

export function writeState(state: ProjectState, env?: Env): void {
  const target = artifactPath(state.id, "state.json", env);
  const tmp = `${target}.tmp`;
  fs.mkdirSync(sfoDir(state.id, env), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
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
