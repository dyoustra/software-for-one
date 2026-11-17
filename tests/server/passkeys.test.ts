import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { APPLE_APP_SITE_ASSOCIATION } from "../../src/server/passkeys.js";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { Vault } from "../../src/server/credentials.js";
import { noGitHubDevice, noSprites } from "./fakes.js";

const RP = "sfo.test";
const ORIGIN = "https://sfo.test";

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const b64 = (b: Uint8Array) => isoBase64URL.fromBuffer(new Uint8Array(b));

/**
 * A software authenticator: a real P-256 key, producing the same registration
 * and sign-in answers a phone would, so the server's real checks run.
 */
function authenticator(origin = ORIGIN, rpID = RP) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const id = randomBytes(16);
  let counter = 0;
  const clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const counterBytes = () => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(counter);
    return b;
  };
  return {
    register(options: { challenge: string }) {
      const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, isoBase64URL.toBuffer(jwk.x)], [-3, isoBase64URL.toBuffer(jwk.y)]]));
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(id.length);
      // Flags: user present, user verified, attested credential data follows.
      const authData = Buffer.concat([sha256(rpID), Buffer.from([0x45]), counterBytes(), Buffer.alloc(16), idLength, id, Buffer.from(cose)]);
      const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: b64(clientData("webauthn.create", options.challenge)), attestationObject: b64(attestationObject), transports: ["internal"] },
      };
    },
    signIn(options: { challenge: string }) {
      counter++;
      const authData = Buffer.concat([sha256(rpID), Buffer.from([0x05]), counterBytes()]);
      const data = clientData("webauthn.get", options.challenge);
      const signature = sign("sha256", Buffer.concat([authData, sha256(data)]), privateKey);
      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: b64(data), authenticatorData: b64(authData), signature: b64(signature) },
      };
    },
  };
}

function server() {
  const db = openDb(":memory:");
  const allowed = new Set(["me", "you"]);
  const oauth = { clientId: "x", authorizeUrl: () => "", whoami: async () => "x", exchange: async () => ({ accessToken: "", refreshToken: null, expiresAt: null }) };
  const app = createApp({
    db, version: "t", verifyApple: async (t) => ({ sub: t }), allowed, publicUrl: "https://cp.test", holdMs: 50,
    vault: new Vault(db, randomBytes(32).toString("base64")), github: oauth, githubRedirects: [], sprites: noSprites, githubDevice: noGitHubDevice, allowedGithub: new Set(),
    passkeys: { rpID: RP, origins: [ORIGIN] },
  });
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const apple = async (who: string) => String((await call("POST", "/auth/apple", { idToken: who })).body.token);
  async function add(token: string, key = authenticator()) {
    const options = (await call("POST", "/passkeys/options", {}, token)).body as { challenge: string };
    return { key, added: await call("POST", "/passkeys", { response: key.register(options), name: "iPhone" }, token) };
  }
  async function signIn(key: ReturnType<typeof authenticator>) {
    const { challengeId, options } = (await call("POST", "/auth/passkey/options", {})).body as { challengeId: string; options: { challenge: string } };
    const answer = key.signIn(options);
    return { challengeId, answer, result: await call("POST", "/auth/passkey", { challengeId, response: answer, deviceName: "phone" }) };
  }
  return { app, db, allowed, call, apple, add, signIn };
}

describe("passkeys", () => {
  it("are added to a signed-in account, listed, and then sign in to it", async () => {
    const s = server();
    const me = await s.apple("me");
    const { key, added } = await s.add(me);
    expect(added).toMatchObject({ status: 200, body: { ok: true } });
    expect((await s.call("GET", "/passkeys", undefined, me)).body).toEqual([expect.objectContaining({ name: "iPhone", lastUsedAt: null })]);
    expect(((await s.call("GET", "/identities", undefined, me)).body as unknown as { provider: string }[]).map((i) => i.provider).sort()).toEqual(["apple", "passkey"]);

    const { result } = await s.signIn(key);
    expect(result.status).toBe(200);
    const token = String(result.body.token);
    expect((await s.call("GET", "/passkeys", undefined, token)).status).toBe(200);
  });

  it("refuse an answer used twice: each challenge is spent once", async () => {
    const s = server();
    const me = await s.apple("me");
    const { key } = await s.add(me);
    const { challengeId, answer } = await s.signIn(key);
    expect((await s.call("POST", "/auth/passkey", { challengeId, response: answer })).status).toBe(403);
  });

  it("refuse an answer made for another site", async () => {
    const s = server();
    const me = await s.apple("me");
    await s.add(me);
    // An answer made for another site's page carries that site as its origin.
    const elsewhere = authenticator("https://evil.test");
    const { challengeId, options } = (await s.call("POST", "/auth/passkey/options", {})).body as { challengeId: string; options: { challenge: string } };
    expect((await s.call("POST", "/auth/passkey", { challengeId, response: elsewhere.signIn(options) })).status).toBe(403);
  });

  it("will not add one made for another site", async () => {
    const s = server();
    const me = await s.apple("me");
    const { added } = await s.add(me, authenticator("https://evil.test"));
    expect(added.status).toBe(400);
  });

  it("do not let an account in once none of its methods is allowlisted", async () => {
    const s = server();
    const me = await s.apple("me");
    const { key } = await s.add(me);
    s.allowed.delete("me");
    expect((await s.signIn(key)).result.status).toBe(403);
  });

  it("approve the CLI's code on the approval page, instead of Apple", async () => {
    const s = server();
    const me = await s.apple("me");
    const { key } = await s.add(me);
    const started = (await s.call("POST", "/auth/device", { name: "mac" })).body as { userCode: string; deviceCode: string };
    const { challengeId, options } = (await s.call("POST", "/auth/passkey/options", {})).body as { challengeId: string; options: { challenge: string } };
    const approved = await s.call("POST", "/approve", { userCode: started.userCode, approve: true, passkey: { challengeId, response: key.signIn(options) } });
    expect(approved.body).toEqual({ ok: true, approved: true, device: "mac" });
    expect((await s.call("GET", `/auth/device/${started.deviceCode}`)).body).toHaveProperty("token");
  });

  it("go with the device that added them, so a stolen device's token leaves nothing behind", async () => {
    const s = server();
    const me = await s.apple("me");
    const other = await s.apple("me");
    const { key } = await s.add(other);
    expect((await s.call("GET", "/passkeys", undefined, me)).body).toEqual([expect.objectContaining({ device: "app" })]);
    const devices = (await s.call("GET", "/devices", undefined, me)).body as unknown as { id: string; current: boolean }[];
    const added = devices.find((d) => !d.current)!;
    await s.call("DELETE", `/devices/${added.id}`, undefined, me);
    expect((await s.call("GET", "/passkeys", undefined, me)).body).toEqual([]);
    expect((await s.signIn(key)).result.status).toBe(403);
  });

  it("take what they let in with them: removing one signs out the devices it signed in, and theirs", async () => {
    const s = server();
    const me = await s.apple("me");
    const stolen = await s.apple("me");
    const { key } = await s.add(stolen);
    const viaPasskey = String((await s.signIn(key)).result.body.token);
    const second = await s.add(viaPasskey);

    const devices = (await s.call("GET", "/devices", undefined, me)).body as unknown as { id: string; name: string; current: boolean }[];
    const stolenId = devices.filter((d) => !d.current)[0].id;
    await s.call("DELETE", `/devices/${stolenId}`, undefined, me);

    expect((await s.call("GET", "/passkeys", undefined, viaPasskey)).status).toBe(401);
    expect((await s.call("GET", "/passkeys", undefined, me)).body).toEqual([]);
    expect((await s.signIn(second.key)).result.status).toBe(403);
    expect((await s.call("GET", "/devices", undefined, me)).status).toBe(200);
  });

  it("signs out a CLI it approved, when it is removed", async () => {
    const s = server();
    const me = await s.apple("me");
    const { key, added } = await s.add(me);
    const started = (await s.call("POST", "/auth/device", { name: "mac" })).body as { userCode: string; deviceCode: string };
    const { challengeId, options } = (await s.call("POST", "/auth/passkey/options", {})).body as { challengeId: string; options: { challenge: string } };
    await s.call("POST", "/approve", { userCode: started.userCode, approve: true, passkey: { challengeId, response: key.signIn(options) } });
    const cli = String((await s.call("GET", `/auth/device/${started.deviceCode}`)).body.token);
    expect((await s.call("GET", "/devices", undefined, cli)).status).toBe(200);

    await s.call("DELETE", `/passkeys/${encodeURIComponent(String(added.body.id))}`, undefined, me);
    expect((await s.call("GET", "/devices", undefined, cli)).status).toBe(401);
  });

  it("cancel a CLI code they approved, if removed before the CLI collects it", async () => {
    const s = server();
    const me = await s.apple("me");
    const { key, added } = await s.add(me);
    const started = (await s.call("POST", "/auth/device", { name: "mac" })).body as { userCode: string; deviceCode: string };
    const { challengeId, options } = (await s.call("POST", "/auth/passkey/options", {})).body as { challengeId: string; options: { challenge: string } };
    await s.call("POST", "/approve", { userCode: started.userCode, approve: true, passkey: { challengeId, response: key.signIn(options) } });
    await s.call("DELETE", `/passkeys/${encodeURIComponent(String(added.body.id))}`, undefined, me);
    expect((await s.call("GET", `/auth/device/${started.deviceCode}`)).body).not.toHaveProperty("token");
  });

  it("are their owner's to remove, and no one else's", async () => {
    const s = server();
    const me = await s.apple("me");
    const { added } = await s.add(me);
    const id = String(added.body.id);
    const you = await s.apple("you");
    expect((await s.call("DELETE", `/passkeys/${encodeURIComponent(id)}`, undefined, you)).status).toBe(404);
    expect((await s.call("DELETE", `/passkeys/${encodeURIComponent(id)}`, undefined, me)).status).toBe(200);
  });

  it("are offered on the approval page, which knows their domain", async () => {
    const page = await (await server().app.request("/approve")).text();
    expect(page).toContain('const PASSKEY_DOMAIN="sfo.test"');
    expect(page).toContain("Approve with a passkey");
  });

  it("are tied to the app by the same association file wherever the domain is served from", async () => {
    const s = server();
    const webCopy = JSON.parse(fs.readFileSync(new URL("../../app/public/.well-known/apple-app-site-association", import.meta.url), "utf8"));
    expect(webCopy).toEqual(APPLE_APP_SITE_ASSOCIATION);
    expect((await s.call("GET", "/.well-known/apple-app-site-association")).body).toEqual({ webcredentials: { apps: ["C8YMKXNGLP.com.youstra.sfo", "K8FHN3DJNA.com.youstra.sfo"] } });
  });
});
