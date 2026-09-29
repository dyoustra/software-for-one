import { execFileSync } from "node:child_process";

export type Notifier = (title: string, message: string) => void;

/**
 * A desktop notification, best effort. Arguments go to AppleScript as argv
 * rather than spliced into the script, so a title with a quote in it stays a
 * title. `SFO_NOTIFY=0` turns it off; so does running under the test runner,
 * which would otherwise notify once per pipeline test.
 */
export const desktopNotifier: Notifier = (title, message) => {
  if (process.env.SFO_NOTIFY === "0" || process.env.VITEST) return;
  try {
    if (process.platform === "darwin") {
      execFileSync(
        "osascript",
        // With a sound: when Script Editor's notification style is set to
        // Notification Center only, the banner never appears, and a sound is
        // what still says it is time to come back.
        [
          "-e",
          "on run argv",
          "-e",
          'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
          "-e",
          "end run",
          title,
          message,
        ],
        { stdio: "ignore", timeout: 5000 },
      );
    } else if (process.platform === "linux") {
      execFileSync("notify-send", [title, message], { stdio: "ignore", timeout: 5000 });
    }
  } catch {
    // A missing notifier must never cost the run its result.
  }
};
