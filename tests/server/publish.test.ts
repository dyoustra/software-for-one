import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { openDb, type Db } from "../../src/server/db.js";
import { Vault } from "../../src/server/credentials.js";
import { publisher } from "../../src/server/publish.js";
import type { VercelApi } from "../../src/server/vercel.js";
import type { SpriteCli } from "../../src/core/sprite.js";

const ID = "tip-calc-abc123";
let db: Db;
let vault: Vault;
let source: string;
let head: string;
let contract: object | null;
let archiveSize = 4096;

const webContract = { gate: [{ name: "t", run: ["npm", "test"], files: "tests/{slice}*" }], publish: { kind: "web", framework: "vite" } };

/** A Sprite whose project is the files in `source`, at commit `head`. */
const sprites: SpriteCli = {
  create: async () => {},
  destroy: async () => {},
  exec: async (_sprite, script) => {
    if (script.includes("rev-parse HEAD")) return { status: 0, stdout: `${head}\n${contract ? JSON.stringify(contract) : ""}` };
    if (script.includes("git -C") && script.includes("archive")) return { status: 0, stdout: `/tmp/sfo-publish.tar\t${archiveSize}\t3\n` };
    return { status: 1, stdout: "unexpected" };
  },
  pull: async (_sprite, _remote, local) => {
    const r = spawnSync("tar", ["-cf", local, "-C", source, "."]);
    if (r.status !== 0) throw new Error("tar failed");
  },
  push: async () => {},
};

function fakeVercel(end: "READY" | "ERROR" = "READY") {
  const calls = { uploads: [] as number[], deploys: [] as { files: { file: string }[]; framework: string | null }[] };
  let looks = 0;
  const api: VercelApi = {
    whoami: async (t) => (t === "good" ? "danny" : Promise.reject(new Error("no"))),
    ensureProject: async (_t, name) => ({ id: "prj_1", name }),
    setEnv: async () => {},
    uploadFile: async (_t, bytes) => {
      calls.uploads.push(bytes.length);
      return { sha: String(bytes.length), size: bytes.length };
    },
    deploy: async (_t, _p, files, framework) => {
      calls.deploys.push({ files, framework });
      return { id: `dpl_${calls.deploys.length}` };
    },
    deployment: async () => (++looks < 2 ? { state: "BUILDING", aliases: [], url: "x", error: null } : end === "READY" ? { state: "READY", aliases: [`${ID}.vercel.app`], url: "tip-xyz.vercel.app", error: null } : { state: "ERROR", aliases: [], url: "", error: "Build failed: vite exited 1" }),
  };
  return { api, calls };
}

function project(): { user_id: string } {
  db.prepare("INSERT INTO users (id, created_at) VALUES ('u', 't')").run();
  db.prepare("INSERT INTO projects (id, user_id, sprite, status, created_at, updated_at) VALUES (?, 'u', 'sfo-00000000', 'ready', 't', 't')").run(ID);
  return { user_id: "u" };
}

const row = () => db.prepare("SELECT publish_state, published_url, published_commit, publish_error, head_commit FROM projects WHERE id = ?").get(ID) as Record<string, string | null>;

beforeEach(() => {
  db = openDb(":memory:");
  vault = new Vault(db, randomBytes(32).toString("base64"));
  source = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-pub-src-"));
  fs.writeFileSync(path.join(source, "index.html"), "<h1>tips</h1>");
  fs.mkdirSync(path.join(source, "src"));
  fs.writeFileSync(path.join(source, "src", "main.js"), "console.log(1)");
  fs.symlinkSync("/etc/hosts", path.join(source, "src", "sneaky"));
  fs.mkdirSync(path.join(source, ".sfo"));
  fs.writeFileSync(path.join(source, ".sfo", "SPEC.md"), "private");
  fs.writeFileSync(path.join(source, ".env.local"), "SECRET=1");
  archiveSize = 4096;
  head = "aaaaaaa";
  contract = webContract;
});

async function settle(inflight: Set<Promise<unknown>>) {
  while (inflight.size > 0) await Promise.all([...inflight]);
}

describe("publishing a web project", () => {
  it("goes live the first time it is delivered: its files to Vercel, the URL and commit kept", async () => {
    const { user_id } = project();
    vault.put(user_id, "vercel_token", "good");
    const { api, calls } = fakeVercel();
    const inflight = new Set<Promise<unknown>>();
    const p = publisher({ db, vault, sprites, vercel: api, inflight, pollMs: 1, log: () => {} });

    await p.delivered({ id: ID, user_id, sprite: "sfo-00000000" });
    await settle(inflight);

    expect(row()).toMatchObject({ publish_state: "live", published_url: `https://${ID}.vercel.app`, published_commit: "aaaaaaa", head_commit: "aaaaaaa", publish_error: null });
    expect(calls.deploys).toHaveLength(1);
    expect(calls.deploys[0].framework).toBe("vite");
    expect(calls.deploys[0].files.map((f) => f.file).sort()).toEqual(["index.html", "src/main.js"]);
  });

  it("refuses an archive its machine says is too large, before pulling it", async () => {
    const { user_id } = project();
    vault.put(user_id, "vercel_token", "good");
    archiveSize = 500 * 1024 * 1024;
    const { api, calls } = fakeVercel();
    const inflight = new Set<Promise<unknown>>();
    await publisher({ db, vault, sprites, vercel: api, inflight, pollMs: 1 }).delivered({ id: ID, user_id, sprite: "sfo-00000000" });
    await settle(inflight);
    expect(row()).toMatchObject({ publish_state: "failed", publish_error: expect.stringMatching(/too large to publish/) });
    expect(calls.uploads).toHaveLength(0);
  });

  it("asks for Vercel, and touches nothing, when it is not connected", async () => {
    const { user_id } = project();
    const { api, calls } = fakeVercel();
    const inflight = new Set<Promise<unknown>>();
    await publisher({ db, vault, sprites, vercel: api, inflight, pollMs: 1 }).delivered({ id: ID, user_id, sprite: "sfo-00000000" });
    await settle(inflight);
    expect(row()).toMatchObject({ publish_state: "needs_connection" });
    expect(calls.deploys).toHaveLength(0);
  });

  it("waits for the person to publish a later delivery, then puts that one up", async () => {
    const { user_id } = project();
    vault.put(user_id, "vercel_token", "good");
    const { api, calls } = fakeVercel();
    const inflight = new Set<Promise<unknown>>();
    const p = publisher({ db, vault, sprites, vercel: api, inflight, pollMs: 1, log: () => {} });
    await p.delivered({ id: ID, user_id, sprite: "sfo-00000000" });
    await settle(inflight);

    head = "bbbbbbb";
    await p.delivered({ id: ID, user_id, sprite: "sfo-00000000" });
    await settle(inflight);
    expect(calls.deploys).toHaveLength(1);
    expect(row()).toMatchObject({ published_commit: "aaaaaaa", head_commit: "bbbbbbb" });

    expect(await p.publish({ id: ID, user_id, sprite: "sfo-00000000" })).toBeNull();
    await settle(inflight);
    expect(calls.deploys).toHaveLength(2);
    expect(row()).toMatchObject({ publish_state: "live", published_commit: "bbbbbbb" });
  });

  it("says why when Vercel's build fails", async () => {
    const { user_id } = project();
    vault.put(user_id, "vercel_token", "good");
    const inflight = new Set<Promise<unknown>>();
    await publisher({ db, vault, sprites, vercel: fakeVercel("ERROR").api, inflight, pollMs: 1 }).delivered({ id: ID, user_id, sprite: "sfo-00000000" });
    await settle(inflight);
    expect(row()).toMatchObject({ publish_state: "failed", publish_error: "Build failed: vite exited 1" });
  });

  it("leaves a project with nothing to put online alone", async () => {
    const { user_id } = project();
    vault.put(user_id, "vercel_token", "good");
    contract = { gate: [{ name: "t", run: ["pytest"], files: "tests/{slice}*" }], install: { run: ["uv", "tool", "install", "."] } };
    const { api, calls } = fakeVercel();
    const inflight = new Set<Promise<unknown>>();
    const p = publisher({ db, vault, sprites, vercel: api, inflight, pollMs: 1 });
    await p.delivered({ id: ID, user_id, sprite: "sfo-00000000" });
    expect(await p.publish({ id: ID, user_id, sprite: "sfo-00000000" })).toBe("it has nothing to put online");
    expect(calls.deploys).toHaveLength(0);
    expect(row()).toMatchObject({ publish_state: null, head_commit: "aaaaaaa" });
  });
});

describe("connecting Vercel", () => {
  it("keeps a token only once Vercel accepts it", async () => {
    const { createApp } = await import("../../src/server/app.js");
    const { noGitHubDevice } = await import("./fakes.js");
    const oauth = { clientId: "x", authorizeUrl: () => "", whoami: async () => "x", exchange: async () => ({ accessToken: "", refreshToken: null, expiresAt: null }) };
    const app = createApp({ db, version: "t", verifyApple: async (t) => ({ sub: t }), allowed: new Set(["me"]), publicUrl: "https://cp.test", vault, github: oauth, githubRedirects: [], sprites, githubDevice: noGitHubDevice, allowedGithub: new Set(), vercel: fakeVercel().api });
    const token = ((await (await app.request("/auth/apple", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: "me" }) })).json()) as { token: string }).token;
    const put = (value: string) => app.request("/credentials/vercel", { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ value }) });

    expect((await put("bad")).status).toBe(400);
    expect(await (await app.request("/credentials", { headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ have: [] });
    expect(await (await put("good")).json()).toEqual({ ok: true, account: "danny" });
    expect(await (await app.request("/credentials", { headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ have: ["vercel_token"] });
  });
});
