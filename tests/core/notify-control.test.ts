import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { reportToControlPlane } from "../../src/core/notify.js";

/**
 * A stand-in control plane in its own process: reportToControlPlane blocks
 * this one while it waits, so a server in this process could never answer.
 * It records the request to `log` and answers 200.
 */
async function controlPlane(log: string): Promise<{ url: string; stop: () => void }> {
  const script = `const http = require("http"); const fs = require("fs");
const s = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)).on("end", () => {
  fs.writeFileSync(process.argv[1], JSON.stringify({ path: req.url, auth: req.headers.authorization, body: b })); res.end("{}"); }); });
s.listen(0, "127.0.0.1", () => console.log(s.address().port));`;
  const child = spawn(process.execPath, ["-e", script, log], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolve) => child.stdout.once("data", (d: Buffer) => resolve(d.toString().trim())));
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

describe("reporting to the control plane from a Sprite", () => {
  it("posts the notification with the token read from its file, and waits for the answer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-ctl-"));
    const log = path.join(dir, "request.json");
    const file = path.join(dir, "control-token");
    fs.writeFileSync(file, "sfow_secret\n");
    const cp = await controlPlane(log);
    try {
      expect(reportToControlPlane("sfo: Moon", "done — SUMMARY.md is ready", { SFO_CONTROL_URL: cp.url }, file)).toBe(true);
      const got = JSON.parse(fs.readFileSync(log, "utf8")) as { path: string; auth: string; body: string };
      expect(got).toEqual({ path: "/workers/events", auth: "Bearer sfow_secret", body: JSON.stringify({ title: "sfo: Moon", message: "done — SUMMARY.md is ready" }) });
    } finally {
      cp.stop();
    }
  });

  it("says it did not report when the control plane cannot be reached", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-ctl-")), "control-token");
    fs.writeFileSync(file, "sfow_secret");
    expect(reportToControlPlane("t", "m", { SFO_CONTROL_URL: "http://127.0.0.1:9" }, file)).toBe(false);
  });

  it("does nothing off a Sprite", () => {
    expect(reportToControlPlane("t", "m", {}, "/nonexistent")).toBe(false);
  });
});
