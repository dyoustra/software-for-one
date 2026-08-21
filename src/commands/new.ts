import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { projectDir, sfoDir, type Env } from "../core/paths.js";
import { writeState } from "../core/state.js";
import { writeArtifact, appendArtifact } from "../core/artifacts.js";
import type { TriageResult } from "../stages/triage.js";

export type TriageFn = (idea: string) => Promise<TriageResult>;

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function createProject(
  idea: string,
  runTriage: TriageFn,
  suffix: string,
  env?: Env,
): Promise<string> {
  const verdict = await runTriage(idea);
  const id = `${slugify(verdict.title)}-${suffix}`;

  const dir = projectDir(id, env);
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

  return id;
}
