import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { holdAwake } from "../../src/core/keepAwake.js";

let server: http.Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

describe("holdAwake", () => {
  it("renews a task named for the project on the Sprite's API socket", async () => {
    const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-sprite-")), "api.sock");
    const seen = new Promise<{ method?: string; url?: string; body: string }>((resolve) => {
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.end("{}");
          resolve({ method: req.method, url: req.url, body });
        });
      });
      server.listen(socket);
    });
    await new Promise((r) => server!.once("listening", r));

    holdAwake("soundscape-1a2b3c", socket);

    const req = await seen;
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("/v1/tasks/sfo-soundscape-1a2b3c");
    expect(JSON.parse(req.body)).toEqual({ expire: "5m" });
  });

  it("does nothing off a Sprite", () => {
    expect(() => holdAwake("p", path.join(os.tmpdir(), "no-such-sprite.sock"))).not.toThrow();
  });
});
