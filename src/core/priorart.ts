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
    /**
     * Required when the verdict is `no_gap`. Null accepted as absent: for a
     * clear gap there is nothing to recommend, and a model saying so with
     * `null` crashed the first run that did.
     */
    recommendation: z.string().nullish(),
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

/** The stage that produces the verdict, and therefore the one a verdict parks. */
const VERDICT_STAGE = "research";

/**
 * The verdict a project is currently stopped *by*, or null.
 *
 * Two things make this narrower than "the file exists and blocks". The verdict
 * only parks a project at `research`, so anything parked later is waiting on
 * something else. And `--anyway` leaves PRIOR_ART.json exactly where it was, so
 * the file's presence alone would keep re-reporting a verdict the human already
 * overrode.
 *
 * Never throws. Callers here are read-only surfaces — a status listing of every
 * project, and a pre-flight check — and neither should die because one project
 * has a malformed artifact. The cost is that a corrupt verdict stops blocking;
 * that is the right trade for a file the pipeline treats as advice to a human.
 */
export function blockingPriorArt(
  state: { id: string; status: string; currentStage: string },
  env?: Env,
): PriorArt | null {
  if (state.status !== "awaiting_human" || state.currentStage !== VERDICT_STAGE) return null;
  let art: PriorArt | null;
  try {
    art = readPriorArt(state.id, env);
  } catch {
    return null;
  }
  return art && blocksPipeline(art.verdict) ? art : null;
}
