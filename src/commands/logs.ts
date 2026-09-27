import fs from "node:fs";
import path from "node:path";
import { sfoDir, type Env } from "../core/paths.js";
import { readState } from "../core/state.js";

const WIDTH = 160;

function oneLine(text: string, max = WIDTH): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function shortPath(p: unknown, cwd: string): string {
  const s = String(p ?? "");
  return cwd && s.startsWith(`${cwd}/`) ? s.slice(cwd.length + 1) : s;
}

function describeTool(name: string, input: Record<string, unknown>, cwd: string): string {
  switch (name) {
    case "Bash":
      return `run    ${oneLine(String(input.command ?? ""))}`;
    case "Read":
      return `read   ${shortPath(input.file_path, cwd)}`;
    case "Write":
      return `write  ${shortPath(input.file_path, cwd)}`;
    case "Edit":
    case "MultiEdit":
      return `edit   ${shortPath(input.file_path, cwd)}`;
    case "WebSearch":
      return `search ${oneLine(String(input.query ?? ""))}`;
    case "WebFetch":
      return `fetch  ${oneLine(String(input.url ?? ""))}`;
    case "Grep":
    case "Glob":
      return `find   ${oneLine(String(input.pattern ?? ""))}`;
    default:
      return `tool   ${name} ${oneLine(JSON.stringify(input), 100)}`;
  }
}

/**
 * One stream-json line as something a person can follow: what the agent says,
 * what it runs and touches, what was refused, and what the stage cost. Thinking
 * and bookkeeping events render as nothing. `cwd` is learned from the init
 * event so paths print relative to the project.
 */
export function renderEvent(line: string, state: { cwd: string }): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return trimmed ? [`       ${oneLine(trimmed)}`] : [];
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }

  if (e.type === "system" && e.subtype === "init") {
    state.cwd = String(e.cwd ?? "");
    return [`── started (${String(e.model ?? "model unknown")})`];
  }
  if (e.type === "system" && e.subtype === "permission_denied") {
    return [`DENIED ${String(e.tool_name ?? "")}: ${oneLine(String(e.message ?? ""))}`];
  }
  if (e.type === "rate_limit_event") {
    const info = (e.rate_limit_info ?? {}) as Record<string, unknown>;
    return info.status === "allowed" ? [] : [`LIMIT  ${String(info.status)} (${String(info.rateLimitType ?? "")})`];
  }
  if (e.type === "result") {
    const cost = typeof e.total_cost_usd === "number" ? `$${e.total_cost_usd.toFixed(2)}` : "cost unknown";
    const mins = typeof e.duration_ms === "number" ? `${(e.duration_ms / 60000).toFixed(1)} min` : "";
    return [`── finished ${e.is_error ? "with an error" : "ok"}: ${cost}, ${String(e.num_turns ?? "?")} turns, ${mins}`];
  }

  const message = e.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [];
  const out: string[] = [];
  for (const b of blocks) {
    if (e.type === "assistant" && b.type === "text" && String(b.text ?? "").trim()) {
      out.push(`says   ${oneLine(String(b.text))}`);
    } else if (e.type === "assistant" && b.type === "tool_use") {
      out.push(describeTool(String(b.name), (b.input ?? {}) as Record<string, unknown>, state.cwd));
    } else if (e.type === "user" && b.type === "tool_result" && b.is_error) {
      const content = Array.isArray(b.content) ? JSON.stringify(b.content) : String(b.content ?? "");
      out.push(`  err  ${oneLine(content, 140)}`);
    }
  }
  return out;
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
