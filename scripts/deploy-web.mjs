// Deploys sfo's own web app to Vercel at sfo.dannyyoustra.com (WEB_APP_SPEC §5).
// Uses the Vercel CLI's login on this machine; sfo holds no Vercel token for it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-web-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

run("npx", ["expo", "export", "-p", "web", "--output-dir", out], path.join(root, "app"));
fs.copyFileSync(path.join(out, "+not-found.html"), path.join(out, "404.html"));
fs.writeFileSync(path.join(out, "vercel.json"), `${JSON.stringify(vercelConfig(), null, 2)}\n`);
run("npx", ["vercel", "link", "--yes", "--project", "sfo-web"], out);
run("npx", ["vercel", "deploy", "--prod", "--yes"], out);

function vercelConfig() {
  return {
    cleanUrls: true,
    // Expo writes a dynamic route's page under its bracketed name; with clean
    // URLs on, a rewrite must name it without .html, and percent-encoded.
    rewrites: [
      { source: "/project/:id", destination: "/project/%5Bid%5D" },
      { source: "/project/:id/:page(cost|log|models|questions|report|slices)", destination: "/project/%5Bid%5D/:page" },
    ],
    headers: [
      { source: "/.well-known/apple-app-site-association", headers: [{ key: "Content-Type", value: "application/json" }] },
      {
        source: "/(.*)",
        headers: [
          // Sign-in and passkeys must never run inside someone else's frame.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ],
  };
}
