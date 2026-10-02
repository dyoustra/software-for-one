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
