import fs from "node:fs";
import { projectsRoot, type Env } from "../core/paths.js";
import { readState, isStale, type ProjectState } from "../core/state.js";

export function listProjects(env?: Env): ProjectState[] {
  const root = projectsRoot(env);
  if (!fs.existsSync(root)) return [];

  const out: ProjectState[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(readState(entry.name, env));
    } catch {
      // A directory with no readable state is not a project. Skip it silently —
      // `sfo status` must never fail because of unrelated junk in the root.
    }
  }
  return out;
}

export function formatStatus(projects: ProjectState[]): string {
  if (projects.length === 0) return "no projects yet — try `sfo new`";

  return projects
    .map((p) => {
      const label =
        p.status === "awaiting_human"
          ? "needs you"
          : p.status === "running" && isStale(p)
            ? "stale (no heartbeat)"
            : p.status;
      return `${p.id.padEnd(32)} ${p.currentStage.padEnd(10)} ${label}`;
    })
    .join("\n");
}
