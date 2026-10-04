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
  return { db, vault, call, signIn, exchanged };
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
  it("stores the account's tokens when GitHub sends the person back", async () => {
    const s = server();
    const token = await s.signIn("me");
    const { url } = (await (await s.call("POST", "/github/connect", token)).json()) as { url: string };
    const state = new URL(url).searchParams.get("state") ?? "";

    const back = await s.call("GET", `/github/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(await back.text()).toContain("GitHub is connected");
    expect(await (await s.call("GET", "/credentials", token)).json()).toEqual({ have: ["github_installation"] });
  });

  it("refuses a callback whose state it did not sign", async () => {
    const s = server();
    await s.signIn("me");
    const forged = `${Buffer.from("someone.99999999999999").toString("base64url")}.not-a-mac`;
    expect((await s.call("GET", `/github/callback?code=abc&state=${forged}`)).status).toBe(400);
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
