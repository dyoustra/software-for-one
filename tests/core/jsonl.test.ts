import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { appendRecord, readRecords, writeRecords } from "../../src/core/jsonl.js";

const Rec = z.object({ id: z.string(), n: z.number() });
let file: string;

beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-jsonl-")), "r.jsonl");
});

describe("jsonl", () => {
  it("returns an empty list when the file does not exist", () => {
    expect(readRecords(file, Rec)).toEqual([]);
  });

  it("appends and reads back in order", () => {
    appendRecord(file, Rec, { id: "a", n: 1 });
    appendRecord(file, Rec, { id: "b", n: 2 });
    expect(readRecords(file, Rec).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("rejects a record that does not match the schema on write", () => {
    expect(() => appendRecord(file, Rec, { id: "a" } as never)).toThrow(/invalid record/i);
  });

  it("throws on a corrupt line rather than skipping it", () => {
    // A skipped criterion silently shrinks the contract the build is held to.
    fs.writeFileSync(file, '{"id":"a","n":1}\nNOT JSON\n');
    expect(() => readRecords(file, Rec)).toThrow(/line 2/i);
  });

  it("throws when a line is valid JSON but the wrong shape", () => {
    fs.writeFileSync(file, '{"id":"a","n":1}\n{"id":"b"}\n');
    expect(() => readRecords(file, Rec)).toThrow(/line 2/i);
  });

  it("ignores blank lines and a trailing newline", () => {
    fs.writeFileSync(file, '{"id":"a","n":1}\n\n');
    expect(readRecords(file, Rec)).toHaveLength(1);
  });

  it("writeRecords replaces the whole file", () => {
    appendRecord(file, Rec, { id: "a", n: 1 });
    writeRecords(file, Rec, [{ id: "z", n: 9 }]);
    expect(readRecords(file, Rec).map((r) => r.id)).toEqual(["z"]);
  });
});
