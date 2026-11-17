import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { Vault } from "../../src/server/credentials.js";
import { noGitHubDevice, noSprites } from "./fakes.js";

const WEB = "https://web.test";

function server() {
  const db = openDb(":memory:");
  const oauth = { clientId: "x", authorizeUrl: () => "", whoami: async () => "x", exchange: async () => ({ accessToken: "", refreshToken: null, expiresAt: null }) };
  const app = createApp({
    db, version: "t", verifyApple: async (t) => ({ sub: t }), allowed: new Set(["me"]), publicUrl: "https://cp.test", holdMs: 50,
    vault: new Vault(db, randomBytes(32).toString("base64")), github: oauth, githubRedirects: [], sprites: noSprites, githubDevice: noGitHubDevice, allowedGithub: new Set(),
    webOrigins: [WEB, "http://localhost:8081"],
  });
  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  /** Signs in as the web app does, and answers the cookie it was given. */
  async function webSignIn() {
    const res = await call("POST", "/auth/apple", { origin: WEB, "x-sfo-session": "cookie" }, { idToken: "me" });
    const set = res.headers.get("set-cookie") ?? "";
    return { res, set, cookie: set.split(";")[0] };
  }
  return { db, call, webSignIn };
}

describe("the web app's session cookie", () => {
  it("is what the web app gets instead of a token: httpOnly, host-only, strict, 30 days", async () => {
    const s = server();
    const { res, set } = await s.webSignIn();
    expect(await res.json()).toEqual({ cookie: true });
    expect(set).toMatch(/^__Host-sfo=sfo_[\w-]+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  });

  it("is not given to an origin that is not ours, nor over plain http, nor unasked", async () => {
    const s = server();
    for (const headers of <Record<string, string>[]>[{ origin: "https://evil.test", "x-sfo-session": "cookie" }, { origin: "http://localhost:8081", "x-sfo-session": "cookie" }, { origin: WEB }]) {
      const res = await s.call("POST", "/auth/apple", headers, { idToken: "me" });
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.json()).toHaveProperty("token");
    }
  });

  it("signs requests in, and each session check slides it on", async () => {
    const s = server();
    const { cookie } = await s.webSignIn();
    expect((await s.call("GET", "/passkeys", { cookie })).status).toBe(200);
    const check = await s.call("GET", "/auth/session", { cookie });
    expect(check.status).toBe(200);
    expect(check.headers.get("set-cookie")).toContain("Max-Age=2592000");
    expect((await s.call("GET", "/auth/session")).status).toBe(401);
  });

  it("changes nothing for a page that is not ours, even one on a sibling subdomain", async () => {
    const s = server();
    const { cookie } = await s.webSignIn();
    for (const origin of [undefined, "https://evil.dannyyoustra.com"]) {
      const res = await s.call("DELETE", "/devices/current", { cookie, ...(origin ? { origin } : {}) });
      expect(res.status).toBe(403);
    }
    expect((await s.call("GET", "/auth/session", { cookie })).status).toBe(200);
  });

  it("holds a token that works only as a cookie, and a bearer token never works as one", async () => {
    const s = server();
    const { cookie } = await s.webSignIn();
    expect((await s.call("GET", "/auth/session", { authorization: `Bearer ${cookie.split("=")[1]}` })).status).toBe(401);
    const bearer = String(((await (await s.call("POST", "/auth/apple", {}, { idToken: "me" })).json()) as { token: string }).token);
    expect((await s.call("GET", "/auth/session", { cookie: `__Host-sfo=${bearer}` })).status).toBe(401);
  });

  it("is cleared by signing out, which revokes its device", async () => {
    const s = server();
    const { cookie } = await s.webSignIn();
    const out = await s.call("DELETE", "/devices/current", { cookie, origin: WEB });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/^__Host-sfo=; Max-Age=0/);
    expect((await s.call("GET", "/auth/session", { cookie })).status).toBe(401);
  });

  it("revokes its device once unused for 30 days", async () => {
    const s = server();
    const { cookie } = await s.webSignIn();
    await s.call("GET", "/auth/session", { cookie });
    s.db.prepare("UPDATE devices SET last_used_at = ? WHERE cookie = 1").run(new Date(Date.now() - 31 * 86_400_000).toISOString());
    expect((await s.call("GET", "/auth/session", { cookie })).status).toBe(401);
    expect(s.db.prepare("SELECT revoked_at FROM devices WHERE cookie = 1").get()).toEqual({ revoked_at: expect.any(String) });
  });

  it("is allowed across origins only for ours, with credentials", async () => {
    const s = server();
    const ours = await s.call("OPTIONS", "/auth/session", { origin: WEB, "access-control-request-method": "GET" });
    expect(ours.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(ours.headers.get("access-control-allow-credentials")).toBe("true");
    const theirs = await s.call("OPTIONS", "/auth/session", { origin: "https://evil.test", "access-control-request-method": "GET" });
    expect(theirs.headers.get("access-control-allow-origin")).toBeNull();
  });
});
