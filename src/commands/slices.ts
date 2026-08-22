import { readSlices, uncoveredCriterionIds, type Slice } from "../core/slices.js";
import { readCriteria, type Criterion } from "../core/criteria.js";
import { readState } from "../core/state.js";
import type { Env } from "../core/paths.js";

const WIDTH = 80;
const ID_COLUMN = "    ".length + 8 + 2;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * `sfo criteria` prints criterion text unwrapped, so a long criterion runs off
 * the terminal and takes the id column of every wrapped line with it. Slices
 * indent one level deeper than that, so the same text has less room here.
 */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.length > 0 ? lines : [""];
}

function criterionLines(id: string, criterion: Criterion | undefined): string[] {
  // Flagged where it occurs rather than in a footer: the useful fact is which
  // slice is about to build nothing, not that some id somewhere is unknown.
  const text = criterion?.text ?? "(no such criterion in CRITERIA.jsonl)";
  const [first, ...rest] = wrap(text, WIDTH - ID_COLUMN);
  return [
    `    ${id.padEnd(8)}  ${first}`,
    ...rest.map((l) => `${" ".repeat(ID_COLUMN)}${l}`),
  ];
}

export function formatSlices(slices: Slice[], criteria: Criterion[]): string {
  if (slices.length === 0) return "no slices yet — has the plan stage run?";

  const byId = new Map(criteria.map((c) => [c.id, c]));
  const blocks = slices.map((s) =>
    [
      `${s.id}  ${s.name}`,
      `  ${plural(s.criterionIds.length, "criterion", "criteria")}`,
      `  prerequisites: ${s.prerequisites.length > 0 ? s.prerequisites.join(", ") : "none"}`,
      ...s.criterionIds.flatMap((c) => criterionLines(c, byId.get(c))),
    ].join("\n"),
  );

  const total = slices.reduce((n, s) => n + s.criterionIds.length, 0);
  const lines = [
    blocks.join("\n\n"),
    `\n${plural(total, "criterion", "criteria")} in ${plural(slices.length, "slice", "slices")}`,
  ];

  // Nothing else reports these yet, and a criterion in no slice is never built,
  // never tested and never mentioned again.
  const uncovered = uncoveredCriterionIds(
    slices,
    criteria.map((c) => c.id),
  );
  if (uncovered.length > 0) {
    lines.push(`warning: ${plural(uncovered.length, "criterion", "criteria")} in no slice: ${uncovered.join(", ")}`);
  }

  return lines.join("\n");
}

export function showSlices(id: string, env?: Env): void {
  // Reading state first so an unknown id reports "no such project" instead of
  // quietly showing an empty list.
  readState(id, env);
  console.log(formatSlices(readSlices(id, env), readCriteria(id, env)));
}
