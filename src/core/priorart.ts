import fs from "node:fs";
import { z } from "zod";
import { artifactPath, sfoDir, type Env } from "./paths.js";

export const PriorArtSchema = z
  .object({
    verdict: z.enum(["no_gap", "marginal_gap", "clear_gap"]),
    summary: z.string().min(1),
    existing: z.array(
      z.object({ name: z.string(), url: z.string(), gap: z.string() }),
    ),
    /** Required when the verdict is `no_gap`. */
    recommendation: z.string().optional(),
  })
  .refine((v) => v.verdict !== "no_gap" || (v.recommendation?.length ?? 0) > 0, {
    message: "no_gap requires a recommendation — stopping without naming what to use instead is a dead end",
  });

export type PriorArt = z.infer<typeof PriorArtSchema>;
export const PRIOR_ART_FILE = "PRIOR_ART.json";

export function readPriorArt(id: string, env?: Env): PriorArt | null {
  const file = artifactPath(id, PRIOR_ART_FILE, env);
  if (!fs.existsSync(file)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${PRIOR_ART_FILE} is not valid JSON`);
  }

  const parsed = PriorArtSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid ${PRIOR_ART_FILE}: ${parsed.error.message}`);
  return parsed.data;
}

export function writePriorArt(id: string, value: PriorArt, env?: Env): void {
  const parsed = PriorArtSchema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid ${PRIOR_ART_FILE}: ${parsed.error.message}`);
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(
    artifactPath(id, PRIOR_ART_FILE, env),
    `${JSON.stringify(parsed.data, null, 2)}\n`,
  );
}

export function blocksPipeline(verdict: PriorArt["verdict"]): boolean {
  return verdict !== "clear_gap";
}
