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

/**
 * Which route a triage call takes.
 *
 * These are NOT the same request. The CLI boots a full agent harness, so the
 * model is told it has file-editing tools, hooks, and whatever CLAUDE.md it
 * discovers; the SDK tells it only that it is a classifier. Same prompt,
 * different context, possibly different verdicts — which is why the choice is
 * recorded and why the command layer announces it.
 */
export type TriagePath = "sdk" | "cli";

/**
 * Env-var presence rather than a trial API call: selection has to be free and
 * deterministic, and must never itself spend money or add latency.
 *
 * This under-selects the SDK in one case: the SDK also authenticates from an
 * `ant auth login` profile on disk, which no env var reveals. Such a user gets
 * the slow path plus a warning naming the fix, which is a visible degradation
 * rather than a silent one.
 */
export function selectTriagePath(env: NodeJS.ProcessEnv = process.env): TriagePath {
  return env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? "sdk" : "cli";
}

// Claude Opus 5 list pricing, USD per million tokens. Hardcoded and will drift
// when pricing changes; the CLI path reports its own total_cost_usd instead.
const OPUS_5_INPUT_PER_MTOK = 5;
const OPUS_5_OUTPUT_PER_MTOK = 25;
const CACHE_WRITE_MULTIPLIER = 1.25; // 5m TTL
const CACHE_READ_MULTIPLIER = 0.1;

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * The Messages API reports token counts, not dollars. Leaving costUsd at 0
 * would make `sfo cost` show every SDK triage as free — an under-report that
 * looks exactly like a real measurement.
 */
export function sdkCostUsd(t: TokenCounts): number {
  return (
    (t.inputTokens * OPUS_5_INPUT_PER_MTOK +
      t.cacheCreationInputTokens * OPUS_5_INPUT_PER_MTOK * CACHE_WRITE_MULTIPLIER +
      t.cacheReadInputTokens * OPUS_5_INPUT_PER_MTOK * CACHE_READ_MULTIPLIER +
      t.outputTokens * OPUS_5_OUTPUT_PER_MTOK) /
    1e6
  );
}

/** What either path hands back: the model's JSON, still un-parsed, plus spend. */
export interface TriageCallResult {
  text: string;
  usage?: StageUsage;
}

export interface TriageSdkInput {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
}

export type TriageSdkImpl = (input: TriageSdkInput) => Promise<TriageCallResult>;
export type TriageCliImpl = typeof runStructured;

/**
 * The fast path: one Messages API call with no agent harness around it.
 *
 * The SDK is imported lazily so that merely loading this module — which every
 * `sfo` command does — neither reads credentials nor constructs a client.
 */
export const runTriageSdk: TriageSdkImpl = async (input) => {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();

  const startedAt = Date.now();
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 16000,
    system: input.system,
    output_config: { format: { type: "json_schema", schema: input.schema } },
    messages: [{ role: "user", content: input.prompt }],
  });

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("triage response contained no text block");
  }

  const counts: TokenCounts = {
    inputTokens: response.usage.input_tokens ?? 0,
    outputTokens: response.usage.output_tokens ?? 0,
    cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
  };

  return {
    text: block.text,
    usage: {
      costUsd: sdkCostUsd(counts),
      durationMs: Date.now() - startedAt,
      numTurns: 1,
      ...counts,
    },
  };
};

export interface TriageOutcome {
  result: TriageResult;
  /** What the call cost, so the caller can record it against the project. */
  usage?: StageUsage;
  /** Which route ran, so the bill can distinguish the cheap one. */
  via: TriagePath;
}

export interface TriageOptions {
  /** Chosen by the command layer so it can warn before the slow call starts. */
  path?: TriagePath;
  sdk?: TriageSdkImpl;
  cli?: TriageCliImpl;
}

/**
 * Both implementations are injectable so tests never construct a real
 * `Anthropic` client or spawn the real `claude` binary.
 *
 * The two paths differ only in how the instructions reach the model — the SDK
 * has a separate `system` field, the CLI takes one prompt argument — and they
 * converge on the same parse, so validation is identical regardless of route.
 */
export async function triage(idea: string, opts: TriageOptions = {}): Promise<TriageOutcome> {
  const via = opts.path ?? selectTriagePath();
  const schema = triageOutputSchema();

  const { text, usage } =
    via === "sdk"
      ? await (opts.sdk ?? runTriageSdk)({ system: SYSTEM, prompt: idea, schema })
      : await (opts.cli ?? runStructured)({
          prompt: `${SYSTEM}\n\nIdea:\n${idea}`,
          schema,
        });

  // Two parses on the CLI path: its envelope's `result` is itself a string of
  // JSON. The SDK returns the text block directly.
  return { result: TriageResultSchema.parse(JSON.parse(text)), usage, via };
}
