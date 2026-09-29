import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { artifactPath, projectsRoot, sfoDir, type Env } from "./paths.js";

/**
 * Every way someone might pay for model calls, including ones nothing can use
 * yet. Declaring the whole roadmap now means adding a backend never changes
 * the schema of a profile already on disk.
 */
export const MODEL_METHODS = [
  "anthropic_api_key",
  "claude_subscription",
  "ollama",
  "openai_api_key",
  "gemini_api_key",
] as const;

export const ModelMethodSchema = z.enum(MODEL_METHODS);
export type ModelMethod = z.infer<typeof ModelMethodSchema>;

/** What sfo's own stages can run on today. */
export const SFO_METHODS = ["claude_subscription", "anthropic_api_key"] as const;
type SfoMethod = (typeof SFO_METHODS)[number];

/** Where the key lives. Never the key itself: the profile is a file on disk. */
export const KeyRefSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("env"), var: z.string().min(1) }),
  z.object({ source: z.literal("keychain"), service: z.string().min(1) }),
]);
export type KeyRef = z.infer<typeof KeyRefSchema>;

export const DEFAULT_KEY_REF: KeyRef = { source: "env", var: "ANTHROPIC_API_KEY" };

export const ProfileSchema = z.object({
  /** What the person has, not which to use. */
  modelAccess: z.array(ModelMethodSchema).min(1),
  apiKey: KeyRefSchema.nullable().default(null),
  sfoPrefers: z.enum(SFO_METHODS),
  /**
   * Off by default: moving from plan limits to billed usage is a cost decision,
   * and a silent switch would make it on the person's behalf.
   */
  fallbackToApiKey: z.boolean().default(false),
  updatedAt: z.string(),
});
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * The per-project copy. Stages read this rather than the profile, so editing
 * the profile later cannot change a project's design halfway through. It holds
 * no key reference because it is committed with the project.
 */
export const AccessSchema = z.object({
  modelAccess: z.array(ModelMethodSchema).min(1),
  sfoPrefers: z.enum(SFO_METHODS),
  /**
   * The Keychain service a built tool reads its key from when the environment
   * has none. A name, not a secret, so it is safe in a committed file; it is
   * what spares the person a shell function to hand the key over.
   */
  keychainService: z.string().min(1).optional(),
});
export type Access = z.infer<typeof AccessSchema>;

export const PROFILE_FILE = "profile.json";
export const ACCESS_FILE = "ACCESS.json";

export function profilePath(env?: Env): string {
  return path.join(projectsRoot(env), PROFILE_FILE);
}

export function readProfile(env?: Env): Profile | null {
  const file = profilePath(env);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON — fix it or delete it and run \`sfo profile setup\``);
  }
  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

export function writeProfile(profile: z.input<typeof ProfileSchema>, env?: Env): Profile {
  const complete = ProfileSchema.parse(profile);
  const file = profilePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(complete, null, 2)}\n`);
  return complete;
}

export function readAccess(id: string, env?: Env): Access | null {
  const file = artifactPath(id, ACCESS_FILE, env);
  if (!fs.existsSync(file)) return null;
  return AccessSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function writeAccess(id: string, access: Access, env?: Env): void {
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(
    artifactPath(id, ACCESS_FILE, env),
    `${JSON.stringify(AccessSchema.parse(access), null, 2)}\n`,
  );
}

export function accessFromProfile(profile: Profile): Access {
  return {
    modelAccess: profile.modelAccess,
    sfoPrefers: profile.sfoPrefers,
    ...(profile.apiKey?.source === "keychain" ? { keychainService: profile.apiKey.service } : {}),
  };
}

/**
 * `--access claude_subscription,anthropic_api_key`. The preference follows the
 * rule a profile would get: the subscription when it is listed.
 */
export function parseAccessFlag(raw: string): Access {
  const methods = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const parsed = z.array(ModelMethodSchema).min(1).safeParse(methods);
  if (!parsed.success) {
    throw new Error(`--access takes a comma-separated list of: ${MODEL_METHODS.join(", ")}`);
  }
  return { modelAccess: parsed.data, sfoPrefers: defaultPreference(parsed.data) };
}

export function defaultPreference(methods: readonly ModelMethod[]): SfoMethod {
  return methods.includes("claude_subscription") || !methods.includes("anthropic_api_key")
    ? "claude_subscription"
    : "anthropic_api_key";
}

export type KeyReader = (ref: KeyRef, env: Env) => string | null;

export const readKey: KeyReader = (ref, env) => {
  if (ref.source === "env") return env[ref.var] || null;
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", ref.service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
};

export function describeKeyRef(ref: KeyRef): string {
  return ref.source === "env" ? `env:${ref.var}` : `keychain:${ref.service}`;
}

export function parseKeyRef(raw: string): KeyRef {
  const [source, rest] = [raw.slice(0, raw.indexOf(":")), raw.slice(raw.indexOf(":") + 1)];
  if (source === "env" && rest) return { source: "env", var: rest };
  if (source === "keychain" && rest) return { source: "keychain", service: rest };
  throw new Error(`key reference must be env:<VAR> or keychain:<service>, got "${raw}"`);
}

/**
 * How one run authenticates. `inherit` is the behaviour from before profiles
 * existed — the child gets whatever the shell had — and survives only for a
 * person with no profile and a project with no snapshot.
 */
export type ResolvedAccess =
  | { method: "claude_subscription" }
  | { method: "anthropic_api_key"; apiKey: string }
  | { method: "inherit" };

export type Billing = "api" | "plan";

export interface ResolveOptions {
  /** `sfo run --use-api-key`: the key for this run, whatever the preference. */
  useApiKey?: boolean;
  env?: Env;
  readKeyWith?: KeyReader;
}

/**
 * Chooses the credential for sfo's own stages. `access` is the project's
 * snapshot when there is one; `triage` passes the profile's (or the override's)
 * because it runs before the project exists.
 */
export function resolveAccess(
  access: Access | null,
  profile: Profile | null,
  opts: ResolveOptions = {},
): ResolvedAccess {
  const env = opts.env ?? process.env;
  const reader = opts.readKeyWith ?? readKey;

  const key = (): string => {
    const ref = profile?.apiKey ?? DEFAULT_KEY_REF;
    const value = reader(ref, env);
    if (!value) {
      throw new Error(
        `no API key found at ${describeKeyRef(ref)} — ` +
          "`sfo profile set key keychain:<service>` or `sfo profile set key env:<VAR>`",
      );
    }
    return value;
  };

  if (opts.useApiKey) return { method: "anthropic_api_key", apiKey: key() };
  if (!access) return { method: "inherit" };

  const usable = access.modelAccess.filter((m): m is SfoMethod =>
    (SFO_METHODS as readonly string[]).includes(m),
  );
  const method = usable.includes(access.sfoPrefers) ? access.sfoPrefers : usable[0];
  if (method === undefined) {
    throw new Error(
      `sfo runs on a Claude subscription or an Anthropic API key, and this project lists neither ` +
        `(${access.modelAccess.join(", ")})`,
    );
  }
  return method === "anthropic_api_key"
    ? { method, apiKey: key() }
    : { method: "claude_subscription" };
}

/** A project's snapshot, else the profile, so projects made before profiles still resolve. */
export function resolveProjectAccess(id: string, opts: ResolveOptions = {}): ResolvedAccess {
  const profile = readProfile(opts.env);
  const access = readAccess(id, opts.env) ?? (profile ? accessFromProfile(profile) : null);
  return resolveAccess(access, profile, opts);
}

/**
 * The child's environment. Removing the variables is the half that matters:
 * Claude Code prefers `ANTHROPIC_API_KEY` to its own login whenever the
 * variable is set, so a key exported in the shell would silently move every
 * stage onto billed usage.
 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  access: ResolvedAccess,
): Record<string, string | undefined> {
  if (access.method === "inherit") return { ...base };
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = base;
  return access.method === "anthropic_api_key" ? { ...rest, ANTHROPIC_API_KEY: access.apiKey } : rest;
}

/** Undefined when the child inherited credentials nobody chose. */
export function billingFor(access: ResolvedAccess, base: NodeJS.ProcessEnv): Billing | undefined {
  if (access.method === "anthropic_api_key") return "api";
  if (access.method === "claude_subscription") return "plan";
  return base.ANTHROPIC_API_KEY ? "api" : undefined;
}
