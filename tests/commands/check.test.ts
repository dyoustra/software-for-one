import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runChecks } from "../../src/commands/check.js";
import { writeState } from "../../src/core/state.js";
import { writeSlices } from "../../src/core/slices.js";
import { readSmokeRecords, latestSmoke } from "../../src/core/smoke.js";
import { deferredWork, deferredCommands } from "../../src/core/deferred.js";
import { readContractFile } from "../../src/core/contracts.js";
import { listProjects, formatStatus } from "../../src/commands/status.js";

let env: Record<string, string>;
let dir: string;
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
/** Stands in for a board on USB: reports one completed check, as a smoke test would. */
const BOARD = `require('fs').appendFileSync(process.env.SFO_SMOKE_RESULTS, JSON.stringify({seam:'x',check:'shows the forecast',level:'completed',detail:'drawn on the panel'})+'\\n')`;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-check-")) };
  dir = path.join(env.SFO_HOME, "p");
  write(".sfo/ARCHETYPE.json", JSON.stringify({ archetype: "firmware for an Adafruit MagTag", why: "e-ink weather" }));
  write(
    ".sfo/CONTRACTS.json",
    JSON.stringify({
      gate: [{ name: "host tests", run: ["true"], files: "tests/{slice}*" }],
      smoke: [{ name: "magtag", run: [process.execPath, "-e", BOARD], needs: ["hardware: Adafruit MagTag on USB"] }],
    }),
  );
  write(
    ".sfo/SERVICES.jsonl",
    JSON.stringify({
      id: "magtag", name: "MagTag e-ink", kind: "platform", effect: "reversible", testMode: null, credential: null, constraints: [],
      smoke: { checks: ["shows the forecast"], maxCostUsd: 0, async: false },
    }) + "\n",
  );
  write(".sfo/SMOKE.jsonl", JSON.stringify({ seam: "magtag", check: "shows the forecast", level: "deferred", detail: "waiting for: hardware: Adafruit MagTag on USB", attempt: 1, at: "2026-10-01T00:00:00.000Z" }) + "\n");
  write(".sfo/SUMMARY.md", "# MagTag weather\n");
  writeSlices("p", [{ id: "S-01", name: "one", criterionIds: ["AC-1"], prerequisites: [] }], env);
  writeState(
    { id: "p", title: "MagTag weather", currentStage: "deliver", status: "done", attempts: {}, slicesPassed: ["S-01"], pid: null, heartbeatAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
    env,
  );
});

const quiet = { log: () => {}, notify: () => {} };

describe("a gate step that needs hardware", () => {
  it("is refused: the gate must run anywhere", () => {
    write(".sfo/CONTRACTS.json", JSON.stringify({ gate: [{ name: "on-board", run: ["pio", "test"], files: "tests/{slice}*", needs: ["hardware: MagTag"] }] }));
    expect(() => readContractFile("p", env)).toThrow(/invalid CONTRACTS\.json/);
  });
});

describe("waiting for the person", () => {
  it("shows in status as waiting, with sfo check as the next step", () => {
    expect(deferredWork("p", env)).toMatchObject({ seams: ["magtag"], needs: ["hardware: Adafruit MagTag on USB"] });
    const out = formatStatus(listProjects(env));
    expect(out).toMatch(/checks waiting for hardware: Adafruit MagTag on USB/);
    expect(out).toMatch(/→ `sfo check p` once you have: hardware: Adafruit MagTag on USB/);
  });
});

describe("sfo check", () => {
  it("runs nothing when the person says the hardware is not there", async () => {
    const out = await runChecks("p", env, { ...quiet, ask: async () => "n" });
    expect(out).toMatch(/not run — `sfo check p` again when you have: hardware: Adafruit MagTag on USB/);
    expect(latestSmoke(readSmokeRecords("p", env))[0].level).toBe("deferred");
  });

  it("runs the deferred checks once confirmed, records them, and stops waiting", async () => {
    const asked: string[] = [];
    const out = await runChecks("p", env, { ...quiet, ask: async (q) => (asked.push(q), "y") });

    expect(asked).toEqual(["Ready: hardware: Adafruit MagTag on USB? [y/N] "]);
    expect(out).toMatch(/magtag — shows the forecast: completed/);
    expect(latestSmoke(readSmokeRecords("p", env))).toMatchObject([{ seam: "magtag", level: "completed" }]);
    expect(fs.readFileSync(path.join(dir, ".sfo/SUMMARY.md"), "utf8")).toMatch(/## Checked with hardware: Adafruit MagTag on USB/);
    expect(formatStatus(listProjects(env))).not.toMatch(/waiting/);
  });

  it("asks nothing with --ready, and runs the checks", async () => {
    const out = await runChecks("p", env, {
      ...quiet,
      ready: true,
      ask: async () => {
        throw new Error("asked despite --ready");
      },
    });
    expect(out).toMatch(/magtag — shows the forecast: completed/);
  });

  it("can show the exact commands it would run, before running a project built elsewhere", () => {
    expect(deferredCommands("p", env)).toEqual([[process.execPath, "-e", BOARD].join(" ")]);
  });

  it("says so when nothing is waiting", async () => {
    write(".sfo/SMOKE.jsonl", "");
    expect(await runChecks("p", env, quiet)).toBe("p has nothing waiting for you");
  });
});
