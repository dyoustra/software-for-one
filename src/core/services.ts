import fs from "node:fs";
import { z } from "zod";
import { artifactPath, sfoDir, type Env } from "./paths.js";
import { readRecords } from "./jsonl.js";
import { KeyRefSchema, ModelMethodSchema } from "./access.js";

export const SERVICES_FILE = "SERVICES.jsonl";
export const CREDENTIALS_FILE = "CREDENTIALS.json";

/**
 * What exercising a seam does to the world, which decides whether smoke may.
 * Set by the spec stage; a wrong label is the one way smoke could do harm.
 */
export const EFFECTS = ["read_only", "billed", "reversible", "irreversible"] as const;

/**
 * A rule with no source is a guess, and a guess is how a 64-character limit
 * became a 128-character hash: required, and required to be a URL.
 */
const ConstraintSchema = z.object({
  rule: z.string().min(1),
  source: z.string().url(),
});

export const ServiceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
  name: z.string().min(1),
  kind: z.enum(["network", "platform"]),
  effect: z.enum(EFFECTS),
  /** How to exercise an irreversible seam without its effect, if the service has a way. */
  testMode: z.string().min(1).nullable(),
  credential: z
    .object({
      /** The environment variable the tool reads. */
      name: z.string().min(1),
      /** The profile method that supplies it, or null for one the profile knows nothing of. */
      covers: ModelMethodSchema.nullable(),
    })
    .nullable(),
  constraints: z.array(ConstraintSchema),
  smoke: z.object({
    checks: z.array(z.string().min(1)),
    maxCostUsd: z.number().nonnegative(),
    async: z.boolean(),
  }),
});
export type Service = z.infer<typeof ServiceSchema>;

export function readServices(id: string, env?: Env): Service[] {
  const services = readRecords(artifactPath(id, SERVICES_FILE, env), ServiceSchema);
  const seen = new Set<string>();
  for (const s of services) {
    if (seen.has(s.id)) throw new Error(`${SERVICES_FILE}: duplicate service id ${s.id}`);
    seen.add(s.id);
  }
  return services;
}

/** Where each credential the profile does not cover lives, by variable name. Never values. */
export const CredentialsSchema = z.record(z.string().min(1), KeyRefSchema);
export type Credentials = z.infer<typeof CredentialsSchema>;

export function readCredentials(id: string, env?: Env): Credentials {
  const file = artifactPath(id, CREDENTIALS_FILE, env);
  if (!fs.existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${CREDENTIALS_FILE} is not valid JSON`);
  }
  const parsed = CredentialsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${CREDENTIALS_FILE} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

export function writeCredentials(id: string, credentials: Credentials, env?: Env): void {
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(
    artifactPath(id, CREDENTIALS_FILE, env),
    `${JSON.stringify(CredentialsSchema.parse(credentials), null, 2)}\n`,
  );
}

/** The smoke test file for a seam: one file per seam, named for its id. */
export function smokeTestFile(service: Service, archetype: string): string {
  const stem = service.id.replace(/-/g, "_");
  return archetype === "cli-node" ? `tests/smoke/smoke_${stem}.test.ts` : `tests/smoke/test_smoke_${stem}.py`;
}
