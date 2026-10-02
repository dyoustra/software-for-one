import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readStack, writeStack, ARCHETYPE_FILE } from "../../src/core/stack.js";

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

  it("accepts whatever the spec says it is building, in its own words", () => {
    // How it is verified lives in the project's contract now, not in a list of
    // names sfo knows; a project with neither is refused at build start.
    specStageWrites('{"archetype":"firmware for an Adafruit MagTag","why":"an e-ink weather display"}');
    expect(readStack("p", env)?.archetype).toBe("firmware for an Adafruit MagTag");
  });

  it("rejects a stack with no reason recorded", () => {
    specStageWrites('{"archetype":"cli-node"}');
    expect(() => readStack("p", env)).toThrow(/ARCHETYPE\.json/);
  });

  it("rejects a file that is not valid JSON", () => {
    specStageWrites("archetype: cli-python\n");
    expect(() => readStack("p", env)).toThrow(/not valid JSON/);
  });

});

describe("writeStack", () => {
  it("round-trips through the reader", () => {
    writeStack("p", { archetype: "cli-node", why: "TypeScript CLI" }, env);
    expect(readStack("p", env)).toEqual({ archetype: "cli-node", why: "TypeScript CLI" });
  });

  it("refuses a description that is empty", () => {
    expect(() => writeStack("p", { archetype: "", why: "x" }, env)).toThrow(/ARCHETYPE\.json/);
    expect(fs.existsSync(path.join(sfo, ARCHETYPE_FILE))).toBe(false);
  });
});
