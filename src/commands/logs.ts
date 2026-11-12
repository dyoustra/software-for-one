import fs from "node:fs";
import path from "node:path";
import { sfoDir, type Env } from "../core/paths.js";
import { readState } from "../core/state.js";
import type { LogEvent } from "../api/types.js";

const WIDTH = 160;

function oneLine(text: string, max = WIDTH): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function shortPath(p: unknown, cwd: string): string {
  const s = String(p ?? "");
  return cwd && s.startsWith(`${cwd}/`) ? s.slice(cwd.length + 1) : s;
}

const TOOL_KINDS: Record<string, "run" | "read" | "write" | "edit" | "search" | "fetch" | "find"> = {
  Bash: "run",
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  WebSearch: "search",
  WebFetch: "fetch",
  Grep: "find",
  Glob: "find",
};

function toolTarget(name: string, input: Record<string, unknown>, cwd: string): string {
  switch (name) {
    case "Bash":
      return oneLine(String(input.command ?? ""), 300);
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return shortPath(input.file_path, cwd);
    case "WebSearch":
      return oneLine(String(input.query ?? ""), 300);
    case "WebFetch":
      return oneLine(String(input.url ?? ""), 300);
    case "Grep":
    case "Glob":
      return oneLine(String(input.pattern ?? ""), 300);
    default:
      return oneLine(JSON.stringify(input), 100);
  }
}

/**
 * One stream-json line as what the run did: what the agent says, what it
 * runs and touches and how that went, what was refused, and what the stage
 * cost. Thinking and bookkeeping events are nothing. `cwd` is learned from the
 * init event so paths are relative to the project.
 */
export function parseEvent(line: string, state: { cwd: string }): LogEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return trimmed ? [{ kind: "note", text: oneLine(trimmed) }] : [];
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }

  if (e.type === "system" && e.subtype === "init") {
    state.cwd = String(e.cwd ?? "");
    return [{ kind: "start", text: String(e.model ?? "model unknown") }];
  }
  if (e.type === "system" && e.subtype === "permission_denied") {
    return [{ kind: "denied", target: String(e.tool_name ?? ""), text: oneLine(String(e.message ?? "")) }];
  }
  if (e.type === "rate_limit_event") {
    const info = (e.rate_limit_info ?? {}) as Record<string, unknown>;
    return info.status === "allowed" ? [] : [{ kind: "limit", text: `${String(info.status)} (${String(info.rateLimitType ?? "")})` }];
  }
  if (e.type === "result") {
    return [
      {
        kind: "finish",
        ok: !e.is_error,
        ...(typeof e.total_cost_usd === "number" ? { costUsd: e.total_cost_usd } : {}),
        ...(typeof e.num_turns === "number" ? { turns: e.num_turns } : {}),
        ...(typeof e.duration_ms === "number" ? { durationMs: e.duration_ms } : {}),
      },
    ];
  }

  const message = e.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [];
  const out: LogEvent[] = [];
  for (const b of blocks) {
    if (e.type === "assistant" && b.type === "text" && String(b.text ?? "").trim()) {
      out.push({ kind: "say", text: String(b.text).trim() });
    } else if (e.type === "assistant" && b.type === "tool_use") {
      const name = String(b.name);
      const kind = TOOL_KINDS[name];
      const input = (b.input ?? {}) as Record<string, unknown>;
      const id = typeof b.id === "string" ? { id: b.id } : {};
      out.push(kind ? { kind, target: toolTarget(name, input, state.cwd), ...id } : { kind: "tool", tool: name, target: toolTarget(name, input, state.cwd), ...id });
    } else if (e.type === "user" && b.type === "tool_result") {
      const id = typeof b.tool_use_id === "string" ? { id: b.tool_use_id } : {};
      if (b.is_error) {
        const content = Array.isArray(b.content) ? JSON.stringify(b.content) : String(b.content ?? "");
        out.push({ kind: "result", ...id, ok: false, text: oneLine(content, 140) });
      } else {
        out.push({ kind: "result", ...id, ok: true });
      }
    }
  }
  return out;
}

/** One stream-json line as `sfo logs` prints it, built on parseEvent. */
export function renderEvent(line: string, state: { cwd: string }): string[] {
  return parseEvent(line, state).flatMap((ev): string[] => {
    switch (ev.kind) {
      case "note":
        return [`       ${ev.text}`];
      case "start":
        return [`── started (${ev.text})`];
      case "denied":
        return [`DENIED ${ev.target}: ${ev.text}`];
      case "limit":
        return [`LIMIT  ${ev.text}`];
      case "finish": {
        const cost = ev.costUsd !== undefined ? `$${ev.costUsd.toFixed(2)}` : "cost unknown";
        const mins = ev.durationMs !== undefined ? `${(ev.durationMs / 60000).toFixed(1)} min` : "";
        return [`── finished ${ev.ok ? "ok" : "with an error"}: ${cost}, ${ev.turns ?? "?"} turns, ${mins}`];
      }
      case "say":
        return [`says   ${oneLine(ev.text)}`];
      case "result":
        return ev.ok ? [] : [`  err  ${ev.text ?? ""}`];
      case "tool":
        return [`tool   ${ev.tool ?? ""} ${ev.target}`];
      case "run":
      case "search":
      case "fetch":
      case "find":
        return [`${ev.kind.padEnd(6)} ${oneLine(ev.target)}`];
      default:
        return [`${ev.kind.padEnd(6)} ${ev.target}`];
    }
  });
}

/** The log being written most recently: the live stage, whatever it is called. */
export function activeLog(id: string, env?: Env): string | null {
  const dir = path.join(sfoDir(id, env), "logs");
  if (!fs.existsSync(dir)) return null;
  const logs = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".log") && !f.endsWith(".verify.log"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return logs.length > 0 ? path.join(dir, logs[0].f) : null;
}

function render(text: string, state: { cwd: string }): string {
  const lines = text.split("\n").flatMap((l) => renderEvent(l, state));
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * The live stage's log, readable. Chosen by what was written last rather than
 * by `currentStage`: during the build that is `build`, and no `build.log`
 * exists — slices log as `build-S-01` and so on. Following switches to the
 * next log when a new stage or slice starts.
 */
export function showLogs(id: string, follow: boolean, env?: Env, opts: { raw?: boolean } = {}): void {
  readState(id, env);
  let file = activeLog(id, env);
  if (!file) {
    console.log("no logs yet");
    return;
  }
  const state = { cwd: "" };
  const show = (text: string): void => {
    process.stdout.write(opts.raw ? text : render(text, state));
  };
  const header = (f: string): void => console.log(`\n═══ ${path.basename(f, ".log")} ═══`);

  header(file);
  let offset = 0;
  let pending = "";
  const drain = (): void => {
    if (!file) return;
    const size = fs.statSync(file).size;
    if (size <= offset) return;
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      // Only whole lines: a JSON event split across two reads parses as neither.
      const text = pending + buf.toString("utf8");
      const cut = text.lastIndexOf("\n");
      pending = cut === -1 ? text : text.slice(cut + 1);
      if (cut !== -1) show(text.slice(0, cut + 1));
    } finally {
      fs.closeSync(fd);
    }
  };
  drain();
  if (!follow) {
    if (pending) show(`${pending}\n`);
    return;
  }

  setInterval(() => {
    const latest = activeLog(id, env);
    if (latest && latest !== file) {
      drain();
      file = latest;
      offset = 0;
      pending = "";
      state.cwd = "";
      header(file);
    }
    drain();
  }, 1000);
}
