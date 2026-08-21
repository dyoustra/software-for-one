import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

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

type TriageClient = Pick<Anthropic, "messages">;

export async function triage(idea: string, client: TriageClient): Promise<TriageResult> {
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: triageOutputSchema() } },
    messages: [{ role: "user", content: idea }],
  });

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("triage response contained no text block");
  }
  return TriageResultSchema.parse(JSON.parse(block.text));
}
