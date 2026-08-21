import { z } from "zod";
import { runStructured } from "../runner/structured.js";
import type { StageUsage } from "../runner/types.js";

export const TriageResultSchema = z.object({
  verdict: z.enum(["ready", "underspecified", "out_of_scope"]),
  title: z.string(),
  reason: z.string(),
  counterOffer: z.string().nullable(),
});

export type TriageResult = z.infer<typeof TriageResultSchema>;

/**
 * Built from zod's own JSON Schema output rather than the SDK's
 * `zodOutputFormat` helper: with zod v4 that helper demotes `enum` into a
 * prose `description`, which would leave `verdict` unconstrained at the API
 * level. `$schema` is stripped because the API rejects unknown top-level keys.
 */
export function triageOutputSchema(): Record<string, unknown> {
  const full = z.toJSONSchema(TriageResultSchema) as Record<string, unknown>;
  const { $schema: _ignored, ...schema } = full;
  return schema;
}

const SYSTEM = `You triage side-project ideas for a pipeline that autonomously builds working software.

Classify the idea:
- "ready" — buildable as described.
- "underspecified" — buildable, but so thin that the later question round will be doing all the work.
- "out_of_scope" — not something an autonomous coding pipeline can produce (training a foundation model, a business rather than software, anything needing hardware nobody has).

Never simply reject. For "out_of_scope", set counterOffer to the nearest thing this pipeline CAN build, phrased as a concrete alternative. Leave counterOffer null otherwise.

Also produce a short title (under 6 words) suitable for a directory name.`;

export interface TriageOutcome {
  result: TriageResult;
  /** What the call cost, so the caller can record it against the project. */
  usage?: StageUsage;
}

/**
 * `run` is injected so tests never spawn the real binary.
 *
 * The CLI takes a single prompt argument with no separate system parameter,
 * so the instructions are prepended to the idea rather than sent apart from it.
 */
export async function triage(
  idea: string,
  run: typeof runStructured = runStructured,
): Promise<TriageOutcome> {
  const { text, usage } = await run({
    prompt: `${SYSTEM}\n\nIdea:\n${idea}`,
    schema: triageOutputSchema(),
  });

  // Two parses: the CLI envelope's `result` is itself a string of JSON.
  return { result: TriageResultSchema.parse(JSON.parse(text)), usage };
}
