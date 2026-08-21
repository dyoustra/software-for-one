import { readPriorArt, blocksPipeline, type PriorArt } from "../core/priorart.js";
import { readState } from "../core/state.js";
import type { Env } from "../core/paths.js";

export function formatWhy(art: PriorArt | null): string {
  if (!art) return "no prior-art verdict yet — has the research stage run?";

  const lines = [
    `verdict: ${art.verdict}${blocksPipeline(art.verdict) ? "   (the pipeline stopped here)" : ""}`,
    "",
    art.summary,
  ];

  if (art.recommendation) lines.push("", `recommendation: ${art.recommendation}`);

  if (art.existing.length > 0) {
    lines.push("", "already out there:");
    for (const e of art.existing) {
      lines.push(`  ${e.name}  ${e.url}`, `    falls short: ${e.gap}`);
    }
  }

  return lines.join("\n");
}

export function showWhy(id: string, env?: Env): void {
  // Reading state first so an unknown id reports "no such project" instead of
  // quietly claiming research never ran.
  readState(id, env);
  console.log(formatWhy(readPriorArt(id, env)));
}
