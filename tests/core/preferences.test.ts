import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  snapshotPreferences,
  readPreferences,
  readSfoMd,
  setPreference,
  sfoMdPath,
  preferencesJsonPath,
  DEFAULT_PREFERENCES,
} from "../../src/core/preferences.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-prefs-")) };
});

describe("structured preferences", () => {
  it("are the defaults until anything is set", () => {
    expect(readPreferences(env)).toEqual(DEFAULT_PREFERENCES);
  });

  it("rank languages per kind, best first", () => {
    const p = setPreference("languages", ["cli", "go,Python"], env);
    expect(p.languages.cli).toEqual(["go", "python"]);
    expect(readPreferences(env).languages.cli).toEqual(["go", "python"]);
  });

  it("refuse anything outside their allowed values, and say what is allowed", () => {
    expect(() => setPreference("languages", ["cli", "pyhton"], env)).toThrow(/a language takes one of: python/);
    expect(() => setPreference("languages", ["desktop", "swift"], env)).toThrow(/cli, web, mobile, firmware, default/);
    expect(() => setPreference("languages", ["cli", "go,go"], env)).toThrow(/ranked twice/);
    expect(() => setPreference("web-host", ["netlify"], env)).toThrow(/vercel, cloudflare, none/);
    expect(() => setPreference("budget", ["lots"], env)).toThrow(/number of dollars/);
    expect(fs.existsSync(preferencesJsonPath(env))).toBe(false);
  });

  it("take no budget as none", () => {
    setPreference("budget", ["25"], env);
    expect(readPreferences(env).budgetUsd).toBe(25);
    setPreference("budget", ["none"], env);
    expect(readPreferences(env).budgetUsd).toBeNull();
  });

  it("refuse a file edited by hand into something invalid", () => {
    fs.writeFileSync(preferencesJsonPath(env), JSON.stringify({ ...DEFAULT_PREFERENCES, webHost: "netlify" }));
    expect(() => readPreferences(env)).toThrow(/not valid .* `sfo prefs`/);
  });
});

describe("SFO.md", () => {
  it("is what PREFERENCES.md was, unchanged", () => {
    fs.writeFileSync(path.join(env.SFO_HOME, "PREFERENCES.md"), "- Web apps: Vite + React.\n");
    expect(readSfoMd(env)).toBe("- Web apps: Vite + React.\n");
    expect(fs.existsSync(sfoMdPath(env))).toBe(true);
    expect(fs.existsSync(path.join(env.SFO_HOME, "PREFERENCES.md"))).toBe(false);
  });
});

describe("snapshotPreferences", () => {
  it("keeps both as they were when the project started", () => {
    fs.writeFileSync(sfoMdPath(env), "- Web apps: Vite + React.\n");
    setPreference("web-host", ["none"], env);
    snapshotPreferences("p", env);
    fs.writeFileSync(sfoMdPath(env), "- Web apps: Next.js.\n");
    setPreference("web-host", ["vercel"], env);

    const dir = path.join(env.SFO_HOME, "p", ".sfo");
    expect(fs.readFileSync(path.join(dir, "SFO.md"), "utf8")).toBe("- Web apps: Vite + React.\n");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "preferences.json"), "utf8")).webHost).toBe("none");
  });
});
