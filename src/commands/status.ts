import fs from "node:fs";
import { projectsRoot, type Env } from "../core/paths.js";
import { readState, isStale, type ProjectState } from "../core/state.js";
import { blockingPriorArt, type PriorArt } from "../core/priorart.js";
import { budgetState } from "../core/budget.js";

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

/**
 * Both halts read as `awaiting_human`, so without this the listing tells
 * someone who is out of money to go answer questions. Derived from the same
 * files the orchestrator gates on rather than stored on the state, so raising
 * the ceiling clears the note immediately.
 *
 * Never throws, for the same reason `blockingPriorArt` does not: one project
 * with a malformed artifact must not break the whole listing. Enforcement lives
 * in `advance` and `guardRunnable`, which do fail closed.
 */
function budgetNote(state: ProjectState, env: Env | undefined): string | undefined {
  if (state.status !== "awaiting_human") return undefined;
  try {
    const budget = budgetState(state.id, env);
    if (!budget?.exceeded) return undefined;
    return `over budget ($${budget.spent.toFixed(2)} of $${budget.ceiling.toFixed(2)}) — \`sfo budget ${state.id} <usd>\``;
  } catch {
    return undefined;
  }
}

export function listProjects(env?: Env): ProjectSummary[] {
  const root = projectsRoot(env);
  if (!fs.existsSync(root)) return [];

  const out: ProjectSummary[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const state = readState(entry.name, env);
      // Prior art leads: it is the only verdict that can end a project rather
      // than pause it, and a budget park is fixable by raising the ceiling.
      const art = blockingPriorArt(state, env);
      const note = art ? noteFor(state, art) : budgetNote(state, env);
      out.push(note !== undefined ? { ...state, note } : state);
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
