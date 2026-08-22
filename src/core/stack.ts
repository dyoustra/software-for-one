import fs from "node:fs";
import { z } from "zod";
import { ARCHETYPE_NAMES } from "./archetype.js";
import { artifactPath, sfoDir, type Env } from "./paths.js";

/**
 * The stack the spec stage chose, written down where a machine can read it.
 *
 * `archetype` is constrained to the registry rather than left free text. An
 * unregistered name has no verify recipe, so accepting one would produce a
 * build in which every slice reports "no gates available" — the same silent
 * collapse as no record at all, with the added insult of looking deliberate.
 */
export const StackSchema = z.object({
  archetype: z.enum(ARCHETYPE_NAMES),
  why: z.string().min(1),
});

export type Stack = z.infer<typeof StackSchema>;

export const ARCHETYPE_FILE = "ARCHETYPE.json";

/**
 * Validated here, on read, because the spec stage writes this file itself —
 * `writeStack` never runs in production, so checks placed there alone would be
 * dead code against the only writer that matters.
 *
 * Throws on a file that exists but does not parse: absent means "not recorded,
 * fall back to sniffing", while malformed means the stage that decides the
 * stack got it wrong, and swallowing that would hand the build an archetype
 * nobody chose.
 */
export function readStack(id: string, env?: Env): Stack | null {
  const file = artifactPath(id, ARCHETYPE_FILE, env);
  if (!fs.existsSync(file)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${ARCHETYPE_FILE} is not valid JSON`);
  }

  const parsed = StackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `invalid ${ARCHETYPE_FILE}: ${parsed.error.message} — archetype must be one of ${ARCHETYPE_NAMES.join(", ")}`,
    );
  }
  return parsed.data;
}

export function writeStack(id: string, stack: Stack, env?: Env): void {
  const parsed = StackSchema.safeParse(stack);
  if (!parsed.success) throw new Error(`invalid ${ARCHETYPE_FILE}: ${parsed.error.message}`);
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  const file = artifactPath(id, ARCHETYPE_FILE, env);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
