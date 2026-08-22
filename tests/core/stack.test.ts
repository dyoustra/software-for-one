import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readStack, writeStack, ARCHETYPE_FILE } from "../../src/core/stack.js";
import { ARCHETYPE_NAMES } from "../../src/core/archetype.js";

let env: Record<string, string>;
let sfo: string;

/** What the spec stage does: writes the file itself, as text. */
function specStageWrites(body: string): void {
  fs.writeFileSync(path.join(sfo, ARCHETYPE_FILE), body);
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-stack-")) };
  sfo = path.join(env.SFO_HOME, "p", ".sfo");
  fs.mkdirSync(sfo, { recursive: true });
});

describe("readStack", () => {
  it("reads back the archetype the spec stage recorded", () => {
    specStageWrites('{"archetype":"cli-python","why":"the idea is a Python CLI"}');
    expect(readStack("p", env)?.archetype).toBe("cli-python");
  });

  it("returns null when nothing has recorded a stack yet", () => {
    // Absent is not an error: it means fall back to sniffing the manifest.
    expect(readStack("p", env)).toBeNull();
  });

  it("rejects an archetype no recipe exists for, rather than passing it through", () => {
    // The failure this guards: "cli-rust" has no verify recipe, so accepting it
    // makes every slice report "no gates available" and fail twice over.
    specStageWrites('{"archetype":"cli-rust","why":"rust is fast"}');

    expect(() => readStack("p", env)).toThrow(/ARCHETYPE\.json/);
    expect(() => readStack("p", env)).toThrow(/cli-python/);
  });

  it("rejects a stack with no reason recorded", () => {
    specStageWrites('{"archetype":"cli-node"}');
    expect(() => readStack("p", env)).toThrow(/ARCHETYPE\.json/);
  });

  it("rejects a file that is not valid JSON", () => {
    specStageWrites("archetype: cli-python\n");
    expect(() => readStack("p", env)).toThrow(/not valid JSON/);
  });

  it("names every archetype the registry knows, so the error is actionable", () => {
    specStageWrites('{"archetype":"nope","why":"x"}');
    for (const name of ARCHETYPE_NAMES) {
      expect(() => readStack("p", env)).toThrow(new RegExp(name));
    }
  });
});

describe("writeStack", () => {
  it("round-trips through the reader", () => {
    writeStack("p", { archetype: "cli-node", why: "TypeScript CLI" }, env);
    expect(readStack("p", env)).toEqual({ archetype: "cli-node", why: "TypeScript CLI" });
  });

  it("refuses to write an archetype the registry does not know", () => {
    expect(() =>
      // Cast because the type already rejects this — the check exists for the
      // JSON path, where nothing is typed.
      writeStack("p", { archetype: "cli-rust" as "cli-node", why: "x" }, env),
    ).toThrow(/ARCHETYPE\.json/);
    expect(fs.existsSync(path.join(sfo, ARCHETYPE_FILE))).toBe(false);
  });
});
