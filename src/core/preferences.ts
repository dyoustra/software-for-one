import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { artifactPath, projectsRoot, sfoDir, type Env } from "./paths.js";

export const SFO_MD = "SFO.md";
export const PREFERENCES_JSON = "preferences.json";
const LEGACY_MD = "PREFERENCES.md";

/** The kinds a language can be ranked for; anything else uses `default`. */
export const KINDS = ["cli", "web", "mobile", "firmware", "default"] as const;

/** Known languages. Adding one is a code change, on purpose: the list is what makes a typo impossible. */
export const LANGUAGES = [
  "python", "typescript", "javascript", "go", "rust", "swift", "kotlin", "java", "cpp", "c", "micropython", "ruby", "elixir",
] as const;

export const WEB_HOSTS = ["vercel", "cloudflare", "none"] as const;
export const WEB_DATA = ["browser", "synced"] as const;

const Ranking = z
  .array(z.enum(LANGUAGES))
  .refine((langs) => new Set(langs).size === langs.length, "a language is ranked twice");

export const PreferencesSchema = z.strictObject({
  languages: z.strictObject(Object.fromEntries(KINDS.map((k) => [k, Ranking])) as Record<(typeof KINDS)[number], typeof Ranking>),
  webHost: z.enum(WEB_HOSTS),
  webData: z.enum(WEB_DATA),
  budgetUsd: z.number().positive().nullable(),
  smokeCapUsd: z.number().min(0),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  languages: { cli: ["python", "go", "typescript"], web: ["typescript"], mobile: ["typescript"], firmware: ["cpp"], default: ["python", "typescript"] },
  webHost: "vercel",
  webData: "browser",
  budgetUsd: null,
  smokeCapUsd: 2,
};

export const SFO_MD_TEMPLATE = `# SFO.md

<!-- Plain words, for anything \`sfo prefs\` has no field for. Every new
     project reads this as guidance, not law: an idea that needs something
     else gets it, and you are asked first. -->
`;

export function sfoMdPath(env?: Env): string {
  return path.join(projectsRoot(env), SFO_MD);
}

export function preferencesJsonPath(env?: Env): string {
  return path.join(projectsRoot(env), PREFERENCES_JSON);
}

/** PREFERENCES.md becomes SFO.md unchanged; nothing is parsed out of it. */
function migrate(env?: Env): void {
  const legacy = path.join(projectsRoot(env), LEGACY_MD);
  if (fs.existsSync(legacy) && !fs.existsSync(sfoMdPath(env))) fs.renameSync(legacy, sfoMdPath(env));
}

export function readSfoMd(env?: Env): string | null {
  migrate(env);
  const file = sfoMdPath(env);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

export function readPreferences(env?: Env): Preferences {
  const file = preferencesJsonPath(env);
  if (!fs.existsSync(file)) return DEFAULT_PREFERENCES;
  const parsed = PreferencesSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} is not valid (${parsed.error.issues[0]?.message}) — change it with \`sfo prefs\`, not by hand`);
  return parsed.data;
}

export function writePreferences(prefs: Preferences, env?: Env): Preferences {
  const valid = PreferencesSchema.parse(prefs);
  fs.mkdirSync(projectsRoot(env), { recursive: true });
  fs.writeFileSync(preferencesJsonPath(env), `${JSON.stringify(valid, null, 2)}\n`);
  return valid;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
  const found = allowed.find((a) => a === value);
  if (!found) throw new Error(`${what} takes one of: ${allowed.join(", ")}`);
  return found;
}

function dollars(value: string, what: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < 0) throw new Error(`${what} takes a number of dollars`);
  return n;
}

export const SETTINGS = ["languages", "web-host", "web-data", "budget", "smoke-cap"] as const;

/** One change, from `sfo prefs <setting> …`. Refuses anything outside its allowed values. */
export function setPreference(setting: string, args: string[], env?: Env): Preferences {
  const next: Preferences = structuredClone(readPreferences(env));
  switch (setting) {
    case "languages": {
      const [kind, list] = args;
      const k = oneOf(kind ?? "", KINDS, "languages <kind>");
      if (!list) throw new Error(`usage: sfo prefs languages ${k} <language,language,…> (best first)`);
      next.languages[k] = list.split(",").map((l) => oneOf(l.trim().toLowerCase(), LANGUAGES, "a language"));
      break;
    }
    case "web-host":
      next.webHost = oneOf(args[0] ?? "", WEB_HOSTS, "web-host");
      break;
    case "web-data":
      next.webData = oneOf(args[0] ?? "", WEB_DATA, "web-data");
      break;
    case "budget":
      next.budgetUsd = args[0] === "none" ? null : dollars(args[0] ?? "", "budget") || null;
      break;
    case "smoke-cap":
      next.smokeCapUsd = dollars(args[0] ?? "", "smoke-cap");
      break;
    default:
      throw new Error(`unknown preference "${setting}" — one of: ${SETTINGS.join(", ")}, or \`edit\` for SFO.md`);
  }
  return writePreferences(next, env);
}

export function formatPreferences(p: Preferences): string {
  return [
    "languages, best first:",
    ...KINDS.map((k) => `  ${k.padEnd(9)} ${p.languages[k].join(", ") || "(none)"}`),
    `web host:  ${p.webHost}`,
    `web data:  ${p.webData}`,
    `budget:    ${p.budgetUsd === null ? "none" : `$${p.budgetUsd.toFixed(2)} per project`}`,
    `smoke cap: $${p.smokeCapUsd.toFixed(2)} per run`,
  ].join("\n");
}

/**
 * The person's preferences as they were when the project started, kept with
 * it like ACCESS.json: a later edit does not redesign a project mid-build.
 */
export function snapshotPreferences(id: string, env?: Env): void {
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(artifactPath(id, PREFERENCES_JSON, env), `${JSON.stringify(readPreferences(env), null, 2)}\n`);
  const text = readSfoMd(env);
  if (text?.trim()) fs.writeFileSync(artifactPath(id, SFO_MD, env), text);
}
