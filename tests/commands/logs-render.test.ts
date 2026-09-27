import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderEvent, activeLog } from "../../src/commands/logs.js";

const ev = (o: object) => JSON.stringify(o);

describe("renderEvent", () => {
  it("shows what the agent says, runs and touches, relative to the project", () => {
    const state = { cwd: "" };
    expect(renderEvent(ev({ type: "system", subtype: "init", cwd: "/p", model: "claude-opus-5" }), state)).toEqual(["── started (claude-opus-5)"]);
    expect(
      renderEvent(
        ev({
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "" },
              { type: "text", text: "Reading the\nidea." },
              { type: "tool_use", name: "Read", input: { file_path: "/p/.sfo/IDEA.md" } },
              { type: "tool_use", name: "Bash", input: { command: "uv run pytest -q" } },
            ],
          },
        }),
        state,
      ),
    ).toEqual(["says   Reading the idea.", "read   .sfo/IDEA.md", "run    uv run pytest -q"]);
  });

  it("shows refusals and failed tool calls, and hides routine events", () => {
    const state = { cwd: "/p" };
    expect(renderEvent(ev({ type: "system", subtype: "permission_denied", tool_name: "Bash", message: "needs approval" }), state)).toEqual([
      "DENIED Bash: needs approval",
    ]);
    expect(renderEvent(ev({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] } }), state)).toEqual([
      "  err  boom",
    ]);
    expect(renderEvent(ev({ type: "system", subtype: "thinking_tokens" }), state)).toEqual([]);
    expect(renderEvent(ev({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }), state)).toEqual([]);
  });

  it("ends with what the stage cost", () => {
    expect(renderEvent(ev({ type: "result", is_error: false, total_cost_usd: 4.49, num_turns: 79, duration_ms: 1356000 }), { cwd: "" })).toEqual([
      "── finished ok: $4.49, 79 turns, 22.6 min",
    ]);
  });
});

describe("activeLog", () => {
  it("picks the log written last, not a verify log, so a slice's log is found during the build", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-logs-"));
    const dir = path.join(home, "p", ".sfo", "logs");
    fs.mkdirSync(dir, { recursive: true });
    const at = (name: string, secondsAgo: number) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, "");
      const t = new Date(Date.now() - secondsAgo * 1000);
      fs.utimesSync(f, t, t);
    };
    at("plan.log", 300);
    at("build-S-01.log", 60);
    at("build-S-01.verify.log", 1);
    expect(activeLog("p", { SFO_HOME: home })).toBe(path.join(dir, "build-S-01.log"));
  });
});
