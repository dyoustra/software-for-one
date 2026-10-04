import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Profile } from "../core/access.js";
import { projectsRoot, type Env } from "../core/paths.js";
import { readPreferences, readSfoMd } from "../core/preferences.js";
import { controlUrl, readControlToken } from "./login.js";

/** A cloud project as `sfo status` lists it. */
export type CloudRow = { id: string; title: string; currentStage: string; status: string; note?: string; next?: string; [k: string]: unknown };

/**
 * Where cloud projects live, for the commands: on the control plane once
 * signed in (`sfo login`), otherwise driven directly with the `sprite` CLI
 * and recorded in cloud.json. The commands are the same either way.
 */
export interface CloudProjects {
  readonly kind: "control" | "direct";
  create(idea: string, opts: { budget?: string; run: boolean }, profile: Profile): Promise<string>;
  list(): Promise<CloudRow[]>;
  has(id: string): Promise<boolean>;
  /** A command about one project, as typed after `sfo`; returns the exit code. */
  command(id: string, argv: string[]): Promise<number>;
  /** A copy of the project here, for hardware checks and installs. */
  pull(id: string): Promise<string>;
  /** What a check left in the local copy, back to the original. */
  pushBack(id: string): Promise<void>;
  destroy(id: string): Promise<{ sprite: string; repo: string | null }>;
}

export async function cloudProjects(env: Env = process.env): Promise<CloudProjects> {
  const token = readControlToken();
  return token && fs.existsSync(path.join(projectsRoot(env), "control.json")) ? controlPlane({ url: controlUrl(env), token }, env) : direct(env);
}

/** "running · on sfo-…": the label status would show, then where. */
function located(summary: CloudRow, sprite: string): CloudRow {
  const label = summary.note ?? (summary.status === "awaiting_human" ? "needs you" : summary.status);
  return { ...summary, note: `${label} · on ${sprite}` };
}

async function direct(env: Env): Promise<CloudProjects> {
  const cloud = await import("../core/cloud.js");
  const { spriteCli } = await import("../core/sprite.js");
  const deps = { cli: spriteCli, env };
  return {
    kind: "direct",
    create: (idea, opts, profile) => cloud.newCloudProject(idea, opts, profile, deps),
    list: async () => (await cloud.cloudSummaries(deps)) as CloudRow[],
    has: async (id) => cloud.cloudEntry(id, env) !== null,
    async command(id, argv) {
      const entry = cloud.cloudEntry(id, env);
      if (!entry) throw new Error(`${id} is not a cloud project`);
      const args = [...argv];
      // An answers file is on this machine; the command runs on the Sprite.
      const from = args.indexOf("--from");
      if (args[0] === "answer" && from !== -1 && args[from + 1] && args[from + 1] !== "-") {
        const remote = `/tmp/sfo-answers-${id}.json`;
        await spriteCli.push(entry.sprite, args[from + 1], remote);
        args[from + 1] = remote;
      }
      return cloud.forward(id, args, deps);
    },
    pull: (id) => cloud.pullProject(id, deps),
    pushBack: (id) => cloud.pushProjectBack(id, deps),
    destroy: async (id) => {
      const entry = await cloud.destroyCloudProject(id, deps);
      return { sprite: entry.sprite, repo: entry.repo };
    },
  };
}

type Present = { id: string; sprite: string; repo: string | null; status: string; summary: CloudRow | null };

/** The control plane's side; `at` is where it is and this device's token. */
export function controlPlane(at: { url: string; token: string }, env: Env = process.env): CloudProjects {
  const raw = (p: string, init: RequestInit = {}) =>
    fetch(`${at.url}${p}`, { ...init, headers: { authorization: `Bearer ${at.token}`, ...(init.headers ?? {}) } });
  const api = async (p: string, init: RequestInit = {}) => {
    const res = await raw(p, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const fail = (r: { status: number; body: Record<string, unknown> }): never => {
    throw new Error(String(r.body.error ?? `the control plane answered ${r.status}`));
  };
  const say = (r: { status: number; body: Record<string, unknown> }): number => {
    if (r.status !== 200) {
      console.error(`sfo: ${String(r.body.error ?? r.status)}`);
      return 1;
    }
    if (r.body.message) console.log(String(r.body.message));
    return 0;
  };

  async function answer(id: string, argv: string[]): Promise<number> {
    const from = argv.indexOf("--from");
    let answers: Record<string, string>;
    if (from !== -1) {
      const file = argv[from + 1];
      answers = JSON.parse(fs.readFileSync(file === "-" || !file ? 0 : file, "utf8")) as Record<string, string>;
    } else {
      const open = await api(`/projects/${id}/questions`);
      if (open.status !== 200) fail(open);
      const questions = open.body as unknown as { id: string; section: string; text: string; context?: string; options: { key: string; label: string; tradeoff: string }[] }[];
      if (questions.length === 0) {
        console.log(`no open questions for ${id}`);
        return 0;
      }
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      answers = {};
      try {
        for (const q of questions) {
          console.log(`\n[${q.section}] ${q.text}`);
          if (q.context) console.log(`  ${q.context}`);
          for (const o of q.options) console.log(`  ${o.key} — ${o.label} — ${o.tradeoff}`);
          answers[q.id] = await rl.question("> ");
        }
      } finally {
        rl.close();
      }
    }
    return say(await api(`/projects/${id}/answers`, { method: "POST", body: JSON.stringify(answers) }));
  }

  async function feedback(id: string, argv: string[]): Promise<number> {
    let text = argv[2];
    if (!text) {
      const { readIdea, editInEditor, readAllStdin } = await import("./new.js");
      text = await readIdea(undefined, {
        isTTY: Boolean(process.stdin.isTTY),
        readStdin: readAllStdin,
        edit: () => editInEditor("\n# What should change? Lines starting with # are ignored.\n"),
      });
    }
    return say(await api(`/projects/${id}/feedback`, { method: "POST", body: JSON.stringify({ text }) }));
  }

  async function bundle(id: string): Promise<string> {
    const res = await raw(`/projects/${id}/bundle`);
    if (!res.ok) throw new Error(`could not download ${id} (${res.status})`);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-pull-")), `${id}.bundle`);
    fs.writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
    return file;
  }

  return {
    kind: "control",
    async create(idea, opts) {
      const res = await raw("/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea, budget: opts.budget, run: opts.run, preferencesJson: JSON.stringify(readPreferences(env)), sfoMd: readSfoMd(env) }),
      });
      if (!res.ok || !res.body) throw new Error(String(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `could not create it (${res.status})`));
      // Progress arrives as lines of JSON while the control plane sets the Sprite up.
      let id: string | null = null;
      let rest = "";
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        rest += decoder.decode(chunk as Uint8Array, { stream: true });
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const event = JSON.parse(line) as { progress?: string; done?: boolean; project?: Present; started?: boolean; error?: string };
          if (event.progress) console.log(event.progress.trim());
          if (event.error) throw new Error(event.error);
          if (event.done && event.project) {
            id = event.project.id;
            if (event.started) console.log("`sfo status` to follow it");
          }
        }
      }
      if (!id) throw new Error("the control plane stopped before the project was made");
      return id;
    },
    async list() {
      const r = await api("/projects");
      if (r.status !== 200) fail(r);
      const rows = r.body as unknown as Present[];
      const out: CloudRow[] = [];
      for (let row of rows) {
        // Only a running project changes on its own; asking wakes its Sprite.
        if (!row.summary || row.summary.status === "running") {
          const fresh = await api(`/projects/${row.id}`);
          if (fresh.status === 200) row = fresh.body as unknown as Present;
        }
        if (row.summary) out.push(located(row.summary, row.sprite));
      }
      return out;
    },
    // Only "not found" means not a cloud project; anything else (signed out,
    // unreachable) is an error, never a reason to treat it as a local one.
    async has(id) {
      const r = await api(`/projects/${id}`);
      if (r.status === 200) return true;
      if (r.status === 404) return false;
      return fail(r);
    },
    async command(id, argv) {
      const [command, , ...rest] = argv;
      switch (command) {
        case "run":
        case "retry":
        case "stop":
          return say(await api(`/projects/${id}/${command}`, { method: "POST", body: JSON.stringify({ anyway: command === "run" && rest.includes("--anyway") }) }));
        case "answer":
          return answer(id, argv);
        case "feedback":
          return feedback(id, argv);
        case "questions": {
          const r = await api(`/projects/${id}/questions`);
          if (r.status !== 200) return say(r);
          console.log(JSON.stringify(r.body));
          return 0;
        }
        case "logs":
          if (rest.includes("-f") || rest.includes("--follow")) {
            throw new Error("following a log live is not through the control plane yet — `sfo logs <id>` shows the current one");
          }
        // falls through: a one-off log is a report
        case "cost":
        case "criteria":
        case "why":
        case "decisions":
        case "slices":
        case "budget": {
          if (command === "budget" && rest.some((a) => !a.startsWith("-"))) throw new Error("changing a cloud project's budget is not through the control plane yet");
          const r = await api(`/projects/${id}/report/${command}${command === "logs" && rest.includes("--raw") ? "?raw=1" : ""}`);
          if (r.status !== 200) return say(r);
          process.stdout.write(String(r.body.output));
          return Number(r.body.status ?? 0);
        }
        default:
          throw new Error(`\`sfo ${command}\` is not available for a cloud project yet`);
      }
    },
    async pull(id) {
      const { checkoutBundle } = await import("../core/cloud.js");
      return checkoutBundle(id, await bundle(id), env);
    },
    async pushBack(id) {
      const { bundleLocalCopy } = await import("../core/cloud.js");
      const file = bundleLocalCopy(id, env);
      const res = await raw(`/projects/${id}/bundle`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(fs.readFileSync(file)),
      });
      if (!res.ok) throw new Error(String(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `could not send the results back (${res.status})`));
    },
    async destroy(id) {
      const found = await api(`/projects/${id}`);
      if (found.status !== 200) fail(found);
      const r = await api(`/projects/${id}`, { method: "DELETE" });
      if (r.status !== 200) fail(r);
      return { sprite: String(found.body.sprite), repo: (found.body.repo as string | null) ?? null };
    },
  };
}
