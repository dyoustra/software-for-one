import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotPreferences, preferencesPath, readPreferences } from "../../src/core/preferences.js";

let env: Record<string, string>;
beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-prefs-")) };
});

describe("preferences", () => {
  it("are absent until written, and copy nothing then", () => {
    expect(readPreferences(env)).toBeNull();
    expect(snapshotPreferences("p", env)).toBe(false);
  });

  it("are copied into a new project, so a later edit does not redesign it mid-build", () => {
    fs.writeFileSync(preferencesPath(env), "- Web apps: Vite + React.\n");
    expect(snapshotPreferences("p", env)).toBe(true);
    fs.writeFileSync(preferencesPath(env), "- Web apps: Next.js.\n");
    expect(fs.readFileSync(path.join(env.SFO_HOME, "p", ".sfo", "PREFERENCES.md"), "utf8")).toBe("- Web apps: Vite + React.\n");
  });
});
