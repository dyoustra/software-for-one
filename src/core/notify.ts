import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type Notifier = (title: string, message: string) => void;

/**
 * The app the person started sfo from. macOS hands every process launched
 * from a GUI app that app's bundle id, a background run inherits it, and so a
 * click can bring back Warp, iTerm or Terminal without naming any of them.
 */
export function spawningApp(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = env.__CFBundleIdentifier;
  return id && /^[A-Za-z0-9.-]+$/.test(id) ? id : null;
}

/** How a notification will be posted: the commands to try, in order. */
export function notificationCommands(title: string, message: string, env: NodeJS.ProcessEnv = process.env): string[][] {
  const app = spawningApp(env);
  return [
    // A notification can only ever show the app that posts it — macOS no
    // longer lets one app post as another — so this one reads
    // "terminal-notifier"; what it can do is bring the person's terminal
    // forward when clicked, which Script Editor's cannot.
    ["terminal-notifier", "-title", title, "-message", message, "-sound", "Glass", "-group", "sfo", ...(app ? ["-activate", app] : [])],
    // With a sound: when the notification style is set to Notification Center
    // only, the banner never appears, and a sound is what still says it is
    // time to come back. Arguments go to AppleScript as argv, never spliced.
    [
      "osascript",
      "-e",
      "on run argv",
      "-e",
      'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
      "-e",
      "end run",
      title,
      message,
    ],
  ];
}

/**
 * A desktop notification, best effort: the first poster that succeeds wins,
 * and a missing or disallowed one falls through to the next. `SFO_NOTIFY=0`
 * turns it off; so does running under the test runner.
 */
export const desktopNotifier: Notifier = (title, message) => {
  if (process.env.SFO_NOTIFY === "0" || process.env.VITEST) return;
  // On a project's Sprite nobody is at the screen: the control plane hears it
  // and pushes it to the person's phone.
  if (reportToControlPlane(title, message)) return;
  const commands =
    process.platform === "darwin"
      ? notificationCommands(title, message)
      : process.platform === "linux"
        ? [["notify-send", title, message]]
        : [];
  for (const [command, ...args] of commands) {
    const r = spawnSync(command, args, { stdio: "ignore", timeout: 5000 });
    if (!r.error && r.status === 0) return;
  }
};

const CONTROL_TOKEN = path.join(os.homedir(), ".config", "sfo", "control-token");

/**
 * Tells the control plane, when this machine is a project's Sprite. Waits for
 * the answer: a run reports how it ended as it exits, and a request left
 * pending would die with the process. The token is read from its file by the
 * child, never passed as an argument.
 */
export function reportToControlPlane(title: string, message: string, env: NodeJS.ProcessEnv = process.env, tokenFile = CONTROL_TOKEN): boolean {
  const url = env.SFO_CONTROL_URL;
  if (!url || !fs.existsSync(tokenFile)) return false;
  const script = `const [url, file] = process.argv.slice(1);
let body = "";
process.stdin.on("data", (d) => (body += d)).on("end", async () => {
  const token = require("fs").readFileSync(file, "utf8").trim();
  try {
    const r = await fetch(url + "/workers/events", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body, signal: AbortSignal.timeout(15000) });
    process.exit(r.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
});`;
  const r = spawnSync(process.execPath, ["-e", script, url, tokenFile], { input: JSON.stringify({ title, message }), timeout: 20_000, stdio: ["pipe", "ignore", "ignore"] });
  return r.status === 0;
}
