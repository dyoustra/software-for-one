import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { Vault, type GitHubOAuth } from "../../src/server/credentials.js";
import type { PushMessage } from "../../src/server/workers.js";
import type { SpriteCli } from "../../src/core/sprite.js";

const PUSH = "ExponentPushToken[abc-123]";

function server() {
  const db = openDb(":memory:");
  const vault = new Vault(db, randomBytes(32).toString("base64"));
  const calls: { script: string; args: string[]; input?: string }[] = [];
  const sprites: SpriteCli = {
    create: async () => {},
    destroy: async () => {},
    exec: async (_s, script, args = [], opts = {}) => {
      calls.push({ script, args, input: opts.input });
      if (script.includes("sfo new")) return { status: 0, stdout: "captured: moon-abc123\n" };
      if (script.includes("status --json")) return { status: 0, stdout: JSON.stringify([{ id: "moon-abc123", title: "Moon", currentStage: "clarify", status: "awaiting_human" }]) };
      return { status: 0, stdout: "" };
    },
    pull: async () => {},
    push: async () => {},
  };
  const pushed: PushMessage[] = [];
  const oauth: GitHubOAuth = { clientId: "x", authorizeUrl: () => "", whoami: async () => "x", exchange: async () => ({ accessToken: "", refreshToken: null, expiresAt: null }) };
  const app = createApp({ db, version: "t", verifyApple: async (t) => ({ sub: t }), allowed: new Set(["me", "you"]), publicUrl: "https://cp.test", vault, github: oauth, githubRedirects: [], sprites, push: async (m) => void pushed.push(...m) });
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { db, calls, pushed, call };
}

async function projectWithWorker(s: ReturnType<typeof server>) {
  const token = ((await (await s.call("POST", "/auth/apple", undefined, { idToken: "me" })).json()) as { token: string }).token;
  await s.call("PUT", "/credentials/claude", token, { value: "sk-ant-oat01-x" });
  await (await s.call("POST", "/projects", token, { idea: "moon" })).text();
  const worker = s.calls.find((c) => c.args[0] === "control-token")?.input ?? "";
  return { token, worker };
}

describe("a project's Sprite", () => {
  it("is told where to report, and with a token of its own, on stdin", async () => {
    const s = server();
    const { worker } = await projectWithWorker(s);
    expect(s.calls.find((c) => c.args[0] === "control-url")?.input).toBe("https://cp.test");
    expect(worker).toMatch(/^sfow_/);
    for (const c of s.calls) expect([c.script, ...c.args].join(" ")).not.toContain(worker);
    expect((s.db.prepare("SELECT token_hash FROM worker_keys").get() as { token_hash: string }).token_hash).not.toBe(worker);
  });

  it("reports a run stopping, and the person's phone is told, tapping through to the project", async () => {
    const s = server();
    const { token, worker } = await projectWithWorker(s);
    expect((await s.call("POST", "/push-tokens", token, { token: PUSH })).status).toBe(200);

    const res = await s.call("POST", "/workers/events", worker, { title: "sfo: Moon", message: "needs you — `sfo answer moon-abc123`" });
    expect(res.status).toBe(200);
    expect(s.pushed).toEqual([{ to: PUSH, title: "Moon", body: "needs you — `sfo answer moon-abc123`", data: { projectId: "moon-abc123" }, sound: "default" }]);
  });

  it("cannot report with anything but its own token", async () => {
    const s = server();
    const { token } = await projectWithWorker(s);
    expect((await s.call("POST", "/workers/events", "sfow_made_up", { title: "x", message: "y" })).status).toBe(401);
    expect((await s.call("POST", "/workers/events", token, { title: "x", message: "y" })).status).toBe(401);
    expect(s.pushed).toEqual([]);
  });

  it("speaks for nothing once its project is deleted", async () => {
    const s = server();
    const { token, worker } = await projectWithWorker(s);
    await s.call("DELETE", "/projects/moon-abc123", token);
    expect((await s.call("POST", "/workers/events", worker, { title: "x", message: "y" })).status).toBe(401);
  });
});

describe("push tokens", () => {
  it("stop receiving once their device is signed out", async () => {
    const s = server();
    const { token, worker } = await projectWithWorker(s);
    await s.call("POST", "/push-tokens", token, { token: PUSH });
    await s.call("DELETE", "/devices/current", token);
    await s.call("POST", "/workers/events", worker, { title: "sfo: Moon", message: "done" });
    expect(s.pushed).toEqual([]);
  });

  it("belong to one account at a time: registering moves them", async () => {
    const s = server();
    const { token, worker } = await projectWithWorker(s);
    await s.call("POST", "/push-tokens", token, { token: PUSH });
    const other = ((await (await s.call("POST", "/auth/apple", undefined, { idToken: "you" })).json()) as { token: string }).token;
    expect((await s.call("POST", "/push-tokens", other, { token: PUSH })).status).toBe(200);
    await s.call("POST", "/workers/events", worker, { title: "sfo: Moon", message: "done" });
    expect(s.pushed).toEqual([]);
  });


  it("are only Expo's", async () => {
    const s = server();
    const token = ((await (await s.call("POST", "/auth/apple", undefined, { idToken: "me" })).json()) as { token: string }).token;
    expect((await s.call("POST", "/push-tokens", token, { token: "https://evil.test" })).status).toBe(400);
  });
});
