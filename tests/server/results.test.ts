import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { Vault, type GitHubOAuth } from "../../src/server/credentials.js";
import type { SpriteCli } from "../../src/core/sprite.js";
import type { ProjectResults } from "../../src/api/types.js";
import { noGitHubDevice } from "./fakes.js";

const ID = "dice-abc123";
let home: string;
let sfo: string;

const sprites: SpriteCli = {
  create: async () => {},
  destroy: async () => {},
  exec: async (_sprite, script, args = []) => {
    const r = spawnSync("bash", ["-c", script, "sfo", ...args], { env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8" });
    return { status: r.status ?? 1, stdout: r.status === 0 ? r.stdout : `${r.stdout}${r.stderr}` };
  },
  pull: async () => {},
  push: async () => {},
};

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const usage = (costUsd: number, durationMs: number) => ({ costUsd, durationMs, numTurns: 1, inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });

function seed(withDelivery: boolean) {
  fs.writeFileSync(
    path.join(sfo, "state.json"),
    JSON.stringify({ id: ID, title: "Dice", currentStage: "deliver", status: "done", attempts: {}, slicesPassed: ["S-01"], slicesFailed: ["S-02"], pid: null, heartbeatAt: null, createdAt: "t", updatedAt: "t" }),
  );
  fs.writeFileSync(path.join(sfo, "INSTALL.json"), JSON.stringify({ installer: "uv", commands: [{ name: "rolld", installed: true, detail: "" }], at: "t" }));
  fs.writeFileSync(path.join(sfo, "CRITERIA.jsonl"), jsonl([{ id: "AC-001", group: "Parsing", text: "a" }, { id: "AC-002", group: "Rolling", text: "b" }, { id: "AC-003", group: "Parsing", text: "c" }]));
  fs.writeFileSync(
    path.join(sfo, "SLICES.jsonl"),
    jsonl([
      { id: "S-01", name: "parse", criterionIds: ["AC-001"], prerequisites: [] },
      { id: "S-02", name: "roll", criterionIds: ["AC-002"], prerequisites: ["S-01"] },
      { id: "S-03", name: "print", criterionIds: ["AC-003"], prerequisites: ["S-02"] },
    ]),
  );
  fs.writeFileSync(
    path.join(sfo, "VERIFY.jsonl"),
    jsonl([
      { slice: "S-01", attempt: 1, ok: true, archetype: "cli-python", tamperedTests: [], at: "2026-11-11T00:00:00Z" },
      { slice: "S-02", attempt: 1, ok: false, archetype: "cli-python", failedStep: "test", reason: "x", tamperedTests: [], at: "2026-11-11T00:00:00Z" },
      { slice: "S-02", attempt: 2, ok: false, archetype: "cli-python", failedStep: "test", reason: "x", tamperedTests: [], at: "2026-11-11T00:00:00Z" },
    ]),
  );
  fs.writeFileSync(
    path.join(sfo, "COST.jsonl"),
    jsonl([
      { stage: "spec", ok: true, usage: usage(0.4, 60_000), billing: "plan", at: "t" },
      { stage: "build-S-02", ok: false, usage: usage(0.3, 30_000), billing: "plan", at: "t" },
      { stage: "build-S-02", ok: false, usage: usage(0.25, 20_000), billing: "plan", at: "t" },
    ]),
  );
  if (withDelivery) {
    fs.writeFileSync(
      path.join(sfo, "DELIVERY.json"),
      JSON.stringify({ what: "A dice roller.", use: [{ kind: "command", command: "rolld 2d6" }], examples: [{ say: "Roll two dice", do: "rolld 2d6" }], features: ["NdS notation"], gaps: [] }),
    );
  }
}

async function results() {
  const db = openDb(":memory:");
  const oauth: GitHubOAuth = { clientId: "x", authorizeUrl: () => "", whoami: async () => "x", exchange: async () => ({ accessToken: "", refreshToken: null, expiresAt: null }) };
  const app = createApp({ db, version: "t", verifyApple: async (t) => ({ sub: t }), allowed: new Set(["me"]), publicUrl: "https://cp.test", vault: new Vault(db, randomBytes(32).toString("base64")), github: oauth, githubRedirects: [], sprites, githubDevice: noGitHubDevice, allowedGithub: new Set() });
  const token = ((await (await app.request("/auth/apple", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: "me" }) })).json()) as { token: string }).token;
  const userId = (db.prepare("SELECT user_id FROM devices").get() as { user_id: string }).user_id;
  db.prepare("INSERT INTO projects (id, user_id, sprite, status, created_at, updated_at) VALUES (?, ?, 'sfo-00000000', 'ready', 't', 't')").run(ID, userId);
  const res = await app.request(`/projects/${ID}/results`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as ProjectResults };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-results-test-"));
  sfo = path.join(home, ".sfo", ID, ".sfo");
  fs.mkdirSync(sfo, { recursive: true });
});

describe("a project's results", () => {
  it("reads the delivery, the installed commands, cost by stage and each slice's result from the Sprite", async () => {
    seed(true);
    const { status, body } = await results();
    expect(status).toBe(200);
    expect(body.delivery?.what).toBe("A dice roller.");
    expect(body.installed).toEqual(["rolld"]);
    expect(body.featuresFallback).toEqual(["Parsing", "Rolling"]);
    expect(body.cost).toEqual({
      totalUsd: 0.95,
      computeMs: 110_000,
      byStage: [
        { stage: "spec", costUsd: 0.4, computeMs: 60_000, ok: true, billing: "plan" },
        { stage: "build-S-02", costUsd: 0.55, computeMs: 50_000, ok: false, billing: "plan" },
      ],
    });
    expect(body.slices).toEqual([
      { id: "S-01", name: "parse", criteria: ["AC-001"], attempts: 1, result: "passed" },
      { id: "S-02", name: "roll", criteria: ["AC-002"], attempts: 2, result: "failed" },
      { id: "S-03", name: "print", criteria: ["AC-003"], attempts: 0, result: "skipped" },
    ]);
  });

  it("has no delivery for a project delivered before DELIVERY.json, and the rest still", async () => {
    seed(false);
    const { body } = await results();
    expect(body.delivery).toBeNull();
    expect(body.installed).toEqual(["rolld"]);
    expect(body.slices).toHaveLength(3);
  });

  it("does not follow a record that is a symlink", async () => {
    seed(true);
    const secret = path.join(home, "secret.json");
    fs.writeFileSync(secret, JSON.stringify({ what: "leaked", use: [{ kind: "step", text: "x" }], examples: [], features: ["x"], gaps: [] }));
    fs.rmSync(path.join(sfo, "DELIVERY.json"));
    fs.symlinkSync(secret, path.join(sfo, "DELIVERY.json"));
    const { body } = await results();
    expect(body.delivery).toBeNull();
  });

  it("is empty, not an error, for a project with no records yet", async () => {
    const { status, body } = await results();
    expect(status).toBe(200);
    expect(body).toEqual({ delivery: null, installed: [], featuresFallback: [], cost: { totalUsd: 0, computeMs: 0, byStage: [] }, slices: [] });
  });
});
