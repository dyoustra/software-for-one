import { describe, it, expect } from "vitest";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import type { VerifyApple } from "../../src/server/apple.js";

/** Apple, as the tests need it: the id token is just the Apple id, or "bad". */
const apple: VerifyApple = async (idToken) => {
  if (idToken === "bad") throw new Error("signature");
  return { sub: idToken, email: `${idToken}@example.com` };
};

function server(allowed = ["me"]) {
  const said: string[] = [];
  const db = openDb(":memory:");
  const app = createApp({ db, version: "t", verifyApple: apple, allowed: new Set(allowed), publicUrl: "https://cp.test", holdMs: 50, log: (m) => said.push(m) });
  const post = (path: string, body: unknown, token?: string) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const get = (path: string, token?: string) => app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { app, db, said, post, get };
}

async function login(s: ReturnType<typeof server>, idToken = "me") {
  const started = (await (await s.post("/auth/device", { name: "danny's mac" })).json()) as { deviceCode: string; userCode: string; verifyUrl: string };
  const approved = await s.post("/approve", { userCode: started.userCode, idToken, approve: true });
  const collected = await s.get(`/auth/device/${started.deviceCode}`);
  return { started, approved, collected };
}

describe("device sign-in", () => {
  it("gives the CLI a token once the person approves its code, signed in with Apple", async () => {
    const s = server();
    const { started, approved, collected } = await login(s);

    expect(started.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(started.verifyUrl).toBe("https://cp.test/approve");
    expect(await approved.json()).toEqual({ ok: true, approved: true, device: "danny's mac" });
    const { token } = (await collected.json()) as { token: string };
    expect(token).toMatch(/^sfo_/);

    const devices = await s.get("/devices", token);
    expect(devices.status).toBe(200);
    expect(((await devices.json()) as { name: string }[]).map((d) => d.name)).toEqual(["danny's mac"]);
  });

  it("stores no token or code a copy of the database could use", async () => {
    const s = server();
    const started = (await (await s.post("/auth/device", {})).json()) as { deviceCode: string; userCode: string };
    await s.post("/approve", { userCode: started.userCode, idToken: "me", approve: true });
    const waiting = s.db.prepare("SELECT * FROM device_codes").get() as Record<string, unknown>;
    expect(waiting.device_code).not.toBe(started.deviceCode);
    expect(waiting.token).toBeNull();
    expect(s.db.prepare("SELECT count(*) AS n FROM devices").get()).toEqual({ n: 0 });
  });

  it("keeps only a hash of a token, and forgets the code once collected", async () => {
    const s = server();
    const { started, collected } = await login(s);
    const { token } = (await collected.json()) as { token: string };
    const stored = s.db.prepare("SELECT token_hash FROM devices").all() as { token_hash: string }[];
    expect(stored.map((r) => r.token_hash)).not.toContain(token);
    expect((await s.get(`/auth/device/${started.deviceCode}`)).status).toBe(410);
  });

  it("holds the CLI's request while it waits, then tells it to ask again", async () => {
    const s = server();
    const { deviceCode } = (await (await s.post("/auth/device", {})).json()) as { deviceCode: string };
    const res = await s.get(`/auth/device/${deviceCode}`);
    expect(res.status).toBe(202);
  });

  it("refuses anyone not allowed in, and logs the id that would allow them", async () => {
    const s = server(["me"]);
    const { approved } = await login(s, "stranger");
    expect(approved.status).toBe(403);
    expect(s.said.join("\n")).toMatch(/refused for Apple id stranger .*SFO_ALLOWED_APPLE_IDS=stranger/);
    expect(s.said.join("\n")).not.toContain("@example.com");
    expect(s.db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it("refuses a token Apple did not sign", async () => {
    const s = server();
    const { approved } = await login(s, "bad");
    expect(approved.status).toBe(403);
  });

  it("tells the waiting CLI when the person denies it", async () => {
    const s = server();
    const started = (await (await s.post("/auth/device", {})).json()) as { deviceCode: string; userCode: string };
    await s.post("/approve", { userCode: started.userCode, idToken: "me", approve: false });
    expect((await s.get(`/auth/device/${started.deviceCode}`)).status).toBe(403);
  });
});

describe("the approval page", () => {
  it("never fills in a code from its link, so a sent link cannot be approved in one click", async () => {
    const s = server();
    const page = await (await s.get("/approve?code=ABCD-EFGH")).text();
    expect(page).not.toContain("ABCD-EFGH");
    expect(page).toMatch(/never approve a code someone sent you/);
  });
});

describe("devices", () => {
  it("refuse a request without a live token", async () => {
    const s = server();
    expect((await s.get("/devices")).status).toBe(401);
    expect((await s.get("/devices", "sfo_made_up")).status).toBe(401);
  });

  it("stop working once revoked", async () => {
    const s = server();
    const { token } = (await (await login(s)).collected.json()) as { token: string };
    const [device] = (await (await s.get("/devices", token)).json()) as { id: string }[];
    expect((await s.app.request(`/devices/${device.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await s.get("/devices", token)).status).toBe(401);
  });

  it("are one person's only: a token cannot revoke someone else's device", async () => {
    const s = server(["me", "you"]);
    const mine = (await (await login(s, "me")).collected.json()) as { token: string };
    const yours = (await (await login(s, "you")).collected.json()) as { token: string };
    const [yourDevice] = (await (await s.get("/devices", yours.token)).json()) as { id: string }[];
    const res = await s.app.request(`/devices/${yourDevice.id}`, { method: "DELETE", headers: { authorization: `Bearer ${mine.token}` } });
    expect(res.status).toBe(404);
    expect((await s.get("/devices", yours.token)).status).toBe(200);
  });
});

describe("app sign-in", () => {
  it("gives the app a token directly from an Apple identity token", async () => {
    const s = server();
    const res = await s.post("/auth/apple", { idToken: "me", deviceName: "iPhone" });
    expect(((await res.json()) as { token: string }).token).toMatch(/^sfo_/);
  });
});
