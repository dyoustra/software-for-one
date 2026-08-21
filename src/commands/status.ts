import fs from "node:fs";
import { projectsRoot, type Env } from "../core/paths.js";
import { readState, isStale, type ProjectState } from "../core/state.js";
import { blockingPriorArt, type PriorArt } from "../core/priorart.js";

/** A project plus whatever short explanation the listing owes the reader. */
export type ProjectSummary = ProjectState & { note?: string };

/** Wide enough for a real recommendation, narrow enough to keep the table a table. */
const NOTE_WIDTH = 64;

function noteFor(state: ProjectState, art: PriorArt): string {
  // Only `no_gap` is guaranteed a recommendation by the schema; a marginal
  // verdict deliberately names no replacement and hands the call back.
  if (art.verdict === "no_gap") return `stopped: ${art.recommendation ?? art.summary}`;
  return `prior art is close — \`sfo why ${state.id}\` to decide`;
}

export function listProjects(env?: Env): ProjectSummary[] {
  const root = projectsRoot(env);
  if (!fs.existsSync(root)) return [];

  const out: ProjectSummary[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const state = readState(entry.name, env);
      const art = blockingPriorArt(state, env);
      out.push(art ? { ...state, note: noteFor(state, art) } : state);
    } catch {
      // A directory with no readable state is not a project. Skip it silently —
      // `sfo status` must never fail because of unrelated junk in the root.
      // (`blockingPriorArt` swallows its own errors for the same reason.)
    }
  }
  return out;
}

export function formatStatus(projects: ProjectSummary[]): string {
  if (projects.length === 0) return "no projects yet — try `sfo new`";

  return projects
    .map((p) => {
      const label =
        p.note !== undefined
          ? truncate(p.note)
          : p.status === "awaiting_human"
            ? "needs you"
            : p.status === "running" && isStale(p)
              ? "stale (no heartbeat)"
              : p.status;
      return `${p.id.padEnd(32)} ${p.currentStage.padEnd(10)} ${label}`;
    })
    .join("\n");
}

function truncate(note: string): string {
  return note.length <= NOTE_WIDTH ? note : `${note.slice(0, NOTE_WIDTH - 1)}…`;
}
