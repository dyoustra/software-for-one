import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, schemaVersion } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { noSprites } from "./fakes.js";
import { Vault } from "../../src/server/credentials.js";
import { randomBytes } from "node:crypto";

describe("control plane", () => {
  it("answers its health check with what is running", async () => {
    const db = openDb(":memory:");
    const github = { clientId: "x", authorizeUrl: () => "", whoami: async () => "x", exchange: async () => ({ accessToken: "", refreshToken: null, expiresAt: null }) };
    const app = createApp({ db, version: "abc1234", verifyApple: async () => ({ sub: "x" }), allowed: new Set(), publicUrl: "http://t", vault: new Vault(db, randomBytes(32).toString("base64")), github, githubRedirects: [], sprites: noSprites });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "abc1234", schema: 5 });
  });

  it("brings a database up to date once, and leaves it there on reopen", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-db-")), "sfo.db");
    const db = openDb(file);
    db.prepare("INSERT INTO users (id, apple_sub, created_at) VALUES (?, ?, ?)").run("u1", "apple-1", "2026-10-04");
    db.close();

    const again = openDb(file);
    expect(schemaVersion(again)).toBe(5);
    expect(again.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  it("enforces that every project belongs to a user", () => {
    const db = openDb(":memory:");
    expect(() =>
      db.prepare("INSERT INTO projects (id, user_id, sprite, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("p", "nobody", "sfo-x", "ready", "t", "t"),
    ).toThrow(/FOREIGN KEY/);
  });
});
