import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { projectDir, sfoDir, type Env } from "../core/paths.js";
import { writeState } from "../core/state.js";
import { writeArtifact, appendArtifact } from "../core/artifacts.js";
import { recordCost } from "../core/cost.js";
import { writeEstimate } from "../core/estimate.js";
import { commitStage } from "../core/repo.js";
import { gitignoreFor } from "../core/archetype.js";
import { writeAccess, type Access } from "../core/access.js";
import type { TriageOutcome, TriagePath } from "../stages/triage.js";

export type TriageFn = (idea: string) => Promise<TriageOutcome>;

const CLI_PATH_WARNING = [
  "sfo: no ANTHROPIC_API_KEY set — running triage through the claude CLI.",
  "     Slower (~10s vs ~2s) and roughly 30x the cost per capture.",
  "     Set ANTHROPIC_API_KEY to use the fast path.",
].join("\n");

/**
 * Printed BEFORE the call, not after: on the CLI path the user otherwise
 * waits ten seconds with no idea why. Announced at all because the two paths
 * are not the same request — the CLI hands the model a tool roster and
 * whatever CLAUDE.md it finds, so it can reach a different verdict. A silent
 * fallback would hand someone a 30x-costlier, behaviourally-different
 * classifier without telling them.
 *
 * Lives in the command layer: the library returns data and does not print.
 */
export function warnSlowTriagePath(
  path: TriagePath,
  log: (message: string) => void = console.error,
): void {
  if (path === "cli") log(CLI_PATH_WARNING);
}

/**
 * Trims AFTER slicing, not before: a 40-char cut that lands on a separator
 * would otherwise reintroduce a trailing dash. Falls back to "project" when a
 * title slugs to nothing (a non-latin or punctuation-only title does), because
 * an empty slug yields an id like "-a1b2c3" — a directory whose name commander
 * parses as an option, making `sfo run <id>` impossible to type.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

export async function createProject(
  idea: string,
  runTriage: TriageFn,
  suffix: string,
  env?: Env,
  access?: Access,
): Promise<string> {
  const { result: verdict, usage, via, billing } = await runTriage(idea);
  const id = `${slugify(verdict.title)}-${suffix}`;

  const dir = projectDir(id, env);
  // Without this guard a colliding id appends the new idea to the existing
  // project's append-only IDEA.md and overwrites its TRIAGE.md and state.json
  // — the new project hijacks the old one and its history is gone, silently.
  if (fs.existsSync(dir)) {
    throw new Error(`project ${id} already exists at ${dir}`);
  }
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  // Archetype is not known until the spec stage runs, so seed the union. The
  // spec stage rewrites this once it has chosen.
  fs.writeFileSync(path.join(dir, ".gitignore"), gitignoreFor("unknown"));

  appendArtifact(id, "IDEA.md", idea, env);
  if (access) writeAccess(id, access, env);
  writeArtifact(
    id,
    "TRIAGE.md",
    [
      `# Triage`,
      ``,
      `- verdict: ${verdict.verdict}`,
      `- reason: ${verdict.reason}`,
      verdict.counterOffer ? `- counter-offer: ${verdict.counterOffer}` : ``,
      ``,
    ].join("\n"),
    env,
  );

  const now = new Date().toISOString();
  writeState(
    {
      id,
      title: verdict.title,
      currentStage: "capture",
      status: "awaiting_human",
      attempts: {},
      pid: null,
      heartbeatAt: null,
      createdAt: now,
      updatedAt: now,
    },
    env,
  );

  // Rides the triage call that already happened rather than paying for a
  // second one. Rough by construction: it knows only the idea's shape, and
  // exists so the user can bail before the front half's real spend.
  writeEstimate(
    id,
    {
      phase: "front",
      lowUsd: verdict.estimateLowUsd,
      highUsd: verdict.estimateHighUsd,
      basis: verdict.estimateBasis,
      at: now,
    },
    env,
  );

  // Only recordable once triage has returned, since the id derives from the
  // title it produced. Triage spends real money and is otherwise invisible
  // to `sfo cost`.
  recordCost(id, "triage", true, usage, env, via, billing);

  // The repo's initial commit. Placed after recordCost so the capture snapshot
  // includes what triage spent, not just what it decided.
  commitStage(id, "capture", env);

  return id;
}
