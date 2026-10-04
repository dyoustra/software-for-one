import fs from "node:fs";
import path from "node:path";
import { artifactPath, projectsRoot, sfoDir, type Env } from "./paths.js";

export const PREFERENCES_FILE = "PREFERENCES.md";

export const PREFERENCES_TEMPLATE = `# What I prefer

<!-- Plain words. Every new project reads this as guidance, not law: an idea
     that needs something else gets it, with the reason recorded. -->

## Languages, best first, by kind of project

- Command-line tools: Python, Go, TypeScript
- Web apps: TypeScript (Vite + React)
- Firmware: C++ (PlatformIO)

## Everything else

- Keep web app data in the browser unless it has to sync.
`;

export function preferencesPath(env?: Env): string {
  return path.join(projectsRoot(env), PREFERENCES_FILE);
}

export function readPreferences(env?: Env): string | null {
  const file = preferencesPath(env);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/**
 * The person's preferences as they were when the project started, kept with
 * it like ACCESS.json: a later edit does not redesign a project mid-build.
 */
export function snapshotPreferences(id: string, env?: Env): boolean {
  const text = readPreferences(env);
  if (text === null || text.trim() === "") return false;
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(artifactPath(id, PREFERENCES_FILE, env), text);
  return true;
}
