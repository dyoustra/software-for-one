import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendVerifyRecord,
  readVerifyRecords,
  VerifyRecordSchema,
  VERIFY_FILE,
  type VerifyRecord,
} from "../../src/core/verifyRecord.js";

let env: Record<string, string>;

const PASSED: VerifyRecord = {
  slice: "S-01",
  attempt: 1,
  ok: true,
  archetype: "cli-python",
  tamperedTests: [],
  at: "2026-08-21T00:00:00.000Z",
};

const FAILED: VerifyRecord = {
  slice: "S-02",
  attempt: 2,
  ok: false,
  archetype: "cli-python",
  failedStep: "test",
  reason: "test failed",
  tamperedTests: [],
  at: "2026-08-21T00:01:00.000Z",
};

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-vrec-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

describe("VERIFY.jsonl", () => {
  it("round-trips a pass and a failure", () => {
    appendVerifyRecord("p", PASSED, env);
    appendVerifyRecord("p", FAILED, env);

    expect(readVerifyRecords("p", env)).toEqual([PASSED, FAILED]);
  });

  it("appends rather than replacing, so both attempts at a slice survive", () => {
    appendVerifyRecord("p", { ...FAILED, slice: "S-01", attempt: 1 }, env);
    appendVerifyRecord("p", { ...FAILED, slice: "S-01", attempt: 2 }, env);

    expect(readVerifyRecords("p", env).map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("is empty rather than an error before any slice has run", () => {
    expect(readVerifyRecords("p", env)).toEqual([]);
  });

  it("carries the test paths a build tampered with", () => {
    appendVerifyRecord("p", { ...FAILED, tamperedTests: ["tests/test_s02.py"] }, env);
    expect(readVerifyRecords("p", env)[0].tamperedTests).toEqual(["tests/test_s02.py"]);
  });

  it("refuses a failure that says nothing about why it failed", () => {
    // Deliver leads with what does not work. A failed slice with no cause reads
    // as a tooling bug rather than as the gate doing its job.
    const silent = { ...FAILED, failedStep: undefined, reason: undefined };
    expect(VerifyRecordSchema.safeParse(silent).success).toBe(false);
  });

  it("refuses a pass that names a failed step", () => {
    expect(VerifyRecordSchema.safeParse({ ...PASSED, failedStep: "test" }).success).toBe(false);
  });

  it("refuses an unparseable timestamp", () => {
    expect(VerifyRecordSchema.safeParse({ ...PASSED, at: "yesterday" }).success).toBe(false);
  });

  it("refuses an attempt number that does not count from one", () => {
    expect(VerifyRecordSchema.safeParse({ ...PASSED, attempt: 0 }).success).toBe(false);
  });

  it("rejects a malformed line on read, where a hand edit would land", () => {
    appendVerifyRecord("p", PASSED, env);
    fs.appendFileSync(
      path.join(env.SFO_HOME, "p", ".sfo", VERIFY_FILE),
      `${JSON.stringify({ slice: "S-03", ok: true })}\n`,
    );

    expect(() => readVerifyRecords("p", env)).toThrow(/does not match schema/);
  });
});
