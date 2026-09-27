import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readServices,
  readCredentials,
  writeCredentials,
  smokeTestFile,
  type Service,
} from "../../src/core/services.js";

let env: Record<string, string>;
beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-svc-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

const BATCH: Service = {
  id: "anthropic-batch",
  name: "Anthropic Message Batches API",
  kind: "network",
  effect: "billed",
  testMode: null,
  credential: { name: "ANTHROPIC_API_KEY", covers: "anthropic_api_key" },
  constraints: [
    { rule: "custom_id matches ^[a-zA-Z0-9_-]{1,64}$", source: "https://docs.anthropic.com/en/api/creating-message-batches" },
  ],
  smoke: { checks: ["submit a one-request batch"], maxCostUsd: 0.01, async: true },
};

function writeLines(records: unknown[]): void {
  fs.writeFileSync(
    path.join(env.SFO_HOME, "p", ".sfo", "SERVICES.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

describe("SERVICES.jsonl", () => {
  it("is empty when absent, for projects made before it existed", () => {
    expect(readServices("p", env)).toEqual([]);
  });

  it("reads a valid seam", () => {
    writeLines([BATCH]);
    expect(readServices("p", env)).toEqual([BATCH]);
  });

  it("rejects a constraint with no source, which is a guess", () => {
    writeLines([{ ...BATCH, constraints: [{ rule: "at most 64 characters" }] }]);
    expect(() => readServices("p", env)).toThrow(/does not match schema/);
  });

  it("rejects a source that is not a link", () => {
    writeLines([{ ...BATCH, constraints: [{ rule: "r", source: "the docs" }] }]);
    expect(() => readServices("p", env)).toThrow(/does not match schema/);
  });

  it("rejects duplicate ids", () => {
    writeLines([BATCH, BATCH]);
    expect(() => readServices("p", env)).toThrow(/duplicate service id anthropic-batch/);
  });
});

describe("CREDENTIALS.json", () => {
  it("holds references, round-trips, and is empty when absent", () => {
    expect(readCredentials("p", env)).toEqual({});
    writeCredentials("p", { GITHUB_TOKEN: { source: "keychain", service: "gh" } }, env);
    expect(readCredentials("p", env)).toEqual({ GITHUB_TOKEN: { source: "keychain", service: "gh" } });
  });

  it("refuses a value in place of a reference", () => {
    expect(() => writeCredentials("p", { GITHUB_TOKEN: "ghp_x" } as never, env)).toThrow();
  });
});

describe("smokeTestFile", () => {
  it("names one file per seam, in the archetype's convention", () => {
    expect(smokeTestFile(BATCH, "cli-python")).toBe("smoke/test_smoke_anthropic_batch.py");
    expect(smokeTestFile(BATCH, "cli-node")).toBe("smoke/smoke_anthropic_batch.test.ts");
  });
});
