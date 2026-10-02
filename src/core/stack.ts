import fs from "node:fs";
import { z } from "zod";
import { artifactPath, sfoDir, type Env } from "./paths.js";

/**
 * What the spec stage decided to build, in its own words: "web app, Vite and
 * React", "firmware for an Adafruit MagTag". Free text, because what a
 * project is verified by now lives in its own contract (CONTRACTS.json); a
 * name sfo has a built-in recipe for (`cli-python`, `cli-node`) still works
 * without one, and a project with neither is refused before the build starts.
 */
export const StackSchema = z.object({
  archetype: z.string().min(1),
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
      `invalid ${ARCHETYPE_FILE}: ${parsed.error.message}`,
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
