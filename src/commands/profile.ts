import readline from "node:readline/promises";
import {
  readProfile,
  writeProfile,
  readKey,
  describeKeyRef,
  parseKeyRef,
  parseAccessFlag,
  defaultPreference,
  profilePath,
  SFO_METHODS,
  type KeyRef,
  type KeyReader,
  type Profile,
} from "../core/access.js";
import type { Env } from "../core/paths.js";

export type Ask = (prompt: string) => Promise<string>;

const DEFAULT_SERVICE = "anthropic-api-key";

const CHOICES = [
  { key: "1", method: "claude_subscription", label: "Claude subscription (Pro or Max)" },
  { key: "2", method: "anthropic_api_key", label: "Anthropic API key" },
] as const;

/**
 * Asked once per person, not per idea: how someone pays for model calls is a
 * fact about them. Left to the spec stage, it surfaced only when a spec
 * happened to raise it, and the first project built a tool its owner could not
 * run.
 *
 * Only the two methods sfo can act on are offered. The schema holds the rest
 * of the roadmap, so offering them later changes no file already on disk.
 */
export async function setupProfile(
  ask: Ask,
  log: (message: string) => void = console.log,
  env: Env = process.env,
  readKeyWith: KeyReader = readKey,
): Promise<Profile> {
  log("How do you pay for model calls? Both is fine — comma-separate them.");
  for (const c of CHOICES) log(`  ${c.key} — ${c.label}`);
  const picked = (await ask("> "))
    .split(",")
    .map((s) => s.trim())
    .map((s) => CHOICES.find((c) => c.key === s)?.method);
  if (picked.length === 0 || picked.some((m) => m === undefined)) {
    throw new Error(`answer with ${CHOICES.map((c) => c.key).join(" and/or ")}, e.g. "1,2"`);
  }
  const modelAccess = [...new Set(picked as (typeof CHOICES)[number]["method"][])];

  let apiKey = null;
  if (modelAccess.includes("anthropic_api_key")) {
    log(
      `Where is the key? A Keychain service name (default ${DEFAULT_SERVICE}), or env:<VAR>.\n` +
        "  The Keychain keeps it out of every process that doesn't need it.",
    );
    const raw = (await ask("> ")).trim() || DEFAULT_SERVICE;
    apiKey = raw.includes(":") ? parseKeyRef(raw) : { source: "keychain" as const, service: raw };
    // Checked now rather than at the first stage that needs it, which could be
    // an hour into an unattended run.
    if (!readKeyWith(apiKey, env)) {
      throw new Error(
        `nothing found at ${describeKeyRef(apiKey)} — add it first ` +
          `(security add-generic-password -a "$USER" -s ${DEFAULT_SERVICE} -w), then run \`sfo profile setup\``,
      );
    }
  }

  const profile = writeProfile(
    {
      modelAccess,
      apiKey,
      sfoPrefers: defaultPreference(modelAccess),
      updatedAt: new Date().toISOString(),
    },
    env,
  );
  log(`saved to ${profilePath(env)}`);
  if (modelAccess.length > 1) {
    log("sfo's own builds will run on your subscription; `sfo profile set prefers anthropic_api_key` to change that.");
  }
  return profile;
}

function stdinAsk(): { ask: Ask; close: () => void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return { ask: (prompt) => rl.question(prompt), close: () => rl.close() };
}

/** Interactive setup with the terminal, refused where there is nobody to answer. */
export async function setupProfileInteractively(env: Env = process.env): Promise<Profile> {
  if (!process.stdin.isTTY) {
    throw new Error("no profile yet, and no terminal to ask — run `sfo profile setup` first");
  }
  const reader = stdinAsk();
  try {
    return await setupProfile(reader.ask, console.log, env);
  } finally {
    reader.close();
  }
}

/** The profile if there is one, else the first-run setup. */
export async function ensureProfile(env: Env = process.env): Promise<Profile> {
  const existing = readProfile(env);
  if (existing) return existing;
  console.log("First run: sfo needs to know how you pay for model calls.");
  return setupProfileInteractively(env);
}

/** Never prints the key, only where it lives and whether it is there. */
export function formatProfile(
  profile: Profile | null,
  env: Env = process.env,
  readKeyWith: KeyReader = readKey,
): string {
  if (!profile) return "no profile yet — `sfo profile setup`";
  const describe = (ref: KeyRef | null): string =>
    ref ? `${describeKeyRef(ref)} (${readKeyWith(ref, env) ? "found" : "NOT FOUND"})` : "none";
  const key = describe(profile.apiKey);
  return [
    `access:    ${profile.modelAccess.join(", ")}`,
    `api key:   ${key}`,
    `sfo runs:  ${profile.sfoPrefers}`,
    `fallback:  ${profile.fallbackToApiKey ? "switch to the API key when the plan limit is hit" : "park when the plan limit is hit"}`,
    `cloud token: ${describe(profile.subscriptionToken)}`,
    `github:    ${describe(profile.githubToken)}`,
  ].join("\n");
}

const SETTINGS = ["access", "key", "prefers", "fallback", "cloud-token", "github"] as const;

export function setProfile(
  setting: string,
  value: string,
  env: Env = process.env,
  readKeyWith: KeyReader = readKey,
): Profile {
  const current = readProfile(env);
  if (!current) throw new Error("no profile yet — run `sfo profile setup` first");
  const next: Profile = { ...current, updatedAt: new Date().toISOString() };

  switch (setting) {
    case "access": {
      const { modelAccess } = parseAccessFlag(value);
      next.modelAccess = modelAccess;
      if (!modelAccess.includes(next.sfoPrefers)) next.sfoPrefers = defaultPreference(modelAccess);
      break;
    }
    case "key": {
      const ref = parseKeyRef(value);
      if (!readKeyWith(ref, env)) throw new Error(`nothing found at ${describeKeyRef(ref)}`);
      next.apiKey = ref;
      break;
    }
    case "prefers": {
      const method = SFO_METHODS.find((m) => m === value);
      if (!method) throw new Error(`prefers takes one of: ${SFO_METHODS.join(", ")}`);
      if (!next.modelAccess.includes(method)) {
        throw new Error(`${method} is not in your access list (${next.modelAccess.join(", ")})`);
      }
      next.sfoPrefers = method;
      break;
    }
    case "fallback": {
      if (value !== "on" && value !== "off") throw new Error("fallback takes on or off");
      next.fallbackToApiKey = value === "on";
      break;
    }
    case "cloud-token":
    case "github": {
      const ref = value === "none" ? null : parseKeyRef(value);
      if (ref && !readKeyWith(ref, env)) throw new Error(`nothing found at ${describeKeyRef(ref)}`);
      if (setting === "cloud-token") next.subscriptionToken = ref;
      else next.githubToken = ref;
      break;
    }
    default:
      throw new Error(`unknown setting "${setting}" — one of: ${SETTINGS.join(", ")}`);
  }
  return writeProfile(next, env);
}
