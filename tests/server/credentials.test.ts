import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { Vault, githubToken, type GitHubOAuth, type GitHubTokens } from "../../src/server/credentials.js";

const CLAUDE = "sk-ant-oat01-secret-value";

function server() {
  const db = openDb(":memory:");
  const vault = new Vault(db, randomBytes(32).toString("base64"));
  const exchanged: unknown[] = [];
  const github: GitHubOAuth = {
    authorizeUrl: (state) => `https://github.test/authorize?state=${state}`,
    exchange: async (grant) => {
      exchanged.push(grant);
      return { accessToken: "code" in grant ? "ghu_first" : "ghu_fresh", refreshToken: "ghr_x", expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString() };
    },
  };
  const app = createApp({ db, version: "t", verifyApple: async (t) => ({ sub: t }), allowed: new Set(["me", "you"]), publicUrl: "https://cp.test", holdMs: 50, vault, github });
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const signIn = async (who: string) => ((await (await call("POST", "/auth/apple", undefined, { idToken: who })).json()) as { token: string }).token;
  return { app, db, vault, call, signIn, exchanged };
}

describe("credentials", () => {
  it("are stored encrypted: the database holds no readable copy", async () => {
    const s = server();
    const token = await s.signIn("me");
    expect((await s.call("PUT", "/credentials/claude", token, { value: CLAUDE })).status).toBe(200);

    const raw = s.db.prepare("SELECT ciphertext FROM credentials").get() as { ciphertext: Uint8Array };
    expect(Buffer.from(raw.ciphertext).toString("utf8")).not.toContain("secret-value");
    const userId = (s.db.prepare("SELECT id FROM users").get() as { id: string }).id;
    expect(s.vault.get(userId, "claude_token")).toBe(CLAUDE);
  });

  it("are only ever listed by kind, never returned", async () => {
    const s = server();
    const token = await s.signIn("me");
    await s.call("PUT", "/credentials/claude", token, { value: CLAUDE });
    const res = await s.call("GET", "/credentials", token);
    expect(await res.text()).toBe(JSON.stringify({ have: ["claude_token"] }));
  });

  it("refuse something that is not the credential named", async () => {
    const s = server();
    const token = await s.signIn("me");
    expect((await s.call("PUT", "/credentials/claude", token, { value: "sk-ant-api03-key" })).status).toBe(400);
    expect((await s.call("PUT", "/credentials/api-key", token, { value: CLAUDE })).status).toBe(400);
  });

  it("are one person's own", async () => {
    const s = server();
    const mine = await s.signIn("me");
    const yours = await s.signIn("you");
    await s.call("PUT", "/credentials/claude", mine, { value: CLAUDE });
    expect(await (await s.call("GET", "/credentials", yours)).json()).toEqual({ have: [] });
  });

  it("cannot be opened with another key", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO users (id, apple_sub, created_at) VALUES ('u', 'me', 't')").run();
    new Vault(db, randomBytes(32).toString("base64")).put("u", "claude_token", CLAUDE);
    expect(() => new Vault(db, randomBytes(32).toString("base64")).get("u", "claude_token")).toThrow();
  });
});

describe("connecting GitHub", () => {
  /** Starts a connection as `who`, then finishes it in a browser signed in as `browser`. */
  async function connect(s: ReturnType<typeof server>, who: string, browser: string) {
    const token = await s.signIn(who);
    const { url } = (await (await s.call("POST", "/github/connect", token)).json()) as { url: string };
    const flow = new URL(url).searchParams.get("flow") ?? "";
    const start = await s.call("POST", "/github/start", undefined, { flow, idToken: browser });
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
    return { token, flow, start, cookie };
  }
  const callback = (s: ReturnType<typeof server>, flow: string, cookie: string) =>
    s.app.request(`/github/callback?code=abc&state=${encodeURIComponent(flow)}`, { headers: cookie ? { cookie } : {} });

  it("stores the account's tokens when the same person finishes in their browser", async () => {
    const s = server();
    const { token, flow, start, cookie } = await connect(s, "me", "me");
    expect(start.status).toBe(200);
    expect(cookie).toMatch(/^sfo_github_flow=/);
    expect(await (await callback(s, flow, cookie)).text()).toContain("GitHub is connected");
    expect(await (await s.call("GET", "/credentials", token)).json()).toEqual({ have: ["github_installation"] });
  });

  it("refuses a link someone else started, so your GitHub cannot be linked to their account", async () => {
    const s = server();
    const { start } = await connect(s, "you", "me");
    expect(start.status).toBe(403);
    expect(start.headers.get("set-cookie")).toBeNull();
  });

  it("refuses GitHub's return in a browser that did not start the flow", async () => {
    const s = server();
    const { flow } = await connect(s, "me", "me");
    expect((await callback(s, flow, "")).status).toBe(400);
    expect(s.exchanged).toEqual([]);
  });

  it("works once: a replayed return is refused", async () => {
    const s = server();
    const { flow, cookie } = await connect(s, "me", "me");
    await callback(s, flow, cookie);
    expect((await callback(s, flow, cookie)).status).toBe(400);
    expect(s.exchanged).toHaveLength(1);
  });

  it("refuses a flow it never started", async () => {
    const s = server();
    await s.signIn("me");
    expect((await callback(s, "made-up", "sfo_github_flow=made-up")).status).toBe(400);
    expect(s.exchanged).toEqual([]);
  });

  it("refreshes a token about to expire before handing it out", async () => {
    const s = server();
    s.db.prepare("INSERT INTO users (id, apple_sub, created_at) VALUES ('u', 'me', 't')").run();
    const expiring: GitHubTokens = { accessToken: "ghu_old", refreshToken: "ghr_x", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    s.vault.put("u", "github_installation", JSON.stringify(expiring));
    const gh: GitHubOAuth = { authorizeUrl: () => "", exchange: async () => ({ accessToken: "ghu_fresh", refreshToken: "ghr_y", expiresAt: null }) };

    expect(await githubToken(s.vault, gh, "u")).toBe("ghu_fresh");
    expect(JSON.parse(s.vault.get("u", "github_installation") ?? "{}").accessToken).toBe("ghu_fresh");
  });
});
