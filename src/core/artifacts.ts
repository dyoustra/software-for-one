import fs from "node:fs";
import { artifactPath, sfoDir, type Env } from "./paths.js";

const APPEND_ONLY = new Set(["DECISIONS.md", "TEST_CHANGES.md", "IDEA.md"]);

export function artifactExists(id: string, name: string, env?: Env): boolean {
  return fs.existsSync(artifactPath(id, name, env));
}

export function readArtifact(id: string, name: string, env?: Env): string | null {
  const p = artifactPath(id, name, env);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

export function writeArtifact(id: string, name: string, body: string, env?: Env): void {
  if (APPEND_ONLY.has(name) && artifactExists(id, name, env)) {
    throw new Error(`${name} is append-only; use appendArtifact`);
  }
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(artifactPath(id, name, env), body);
}

export function appendArtifact(id: string, name: string, body: string, env?: Env): void {
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.appendFileSync(artifactPath(id, name, env), `${body}\n`);
}
