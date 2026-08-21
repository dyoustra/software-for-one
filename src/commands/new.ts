import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { projectDir, sfoDir, type Env } from "../core/paths.js";
import { writeState } from "../core/state.js";
import { writeArtifact, appendArtifact } from "../core/artifacts.js";
import { recordCost } from "../core/cost.js";
import type { TriageOutcome } from "../stages/triage.js";

export type TriageFn = (idea: string) => Promise<TriageOutcome>;

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
): Promise<string> {
  const { result: verdict, usage } = await runTriage(idea);
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

  appendArtifact(id, "IDEA.md", idea, env);
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

  // Only recordable once triage has returned, since the id derives from the
  // title it produced. Triage spends real money and is otherwise invisible
  // to `sfo cost`.
  recordCost(id, "triage", true, usage, env);

  return id;
}
