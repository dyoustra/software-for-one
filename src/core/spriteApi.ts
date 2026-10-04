import fs from "node:fs";
import type { SpriteCli } from "./sprite.js";

const STDOUT = 0x01;
const STDERR = 0x02;
const EXIT = 0x03;

/**
 * The exec endpoint's response: a stream of chunks, each led by a byte that
 * says what follows — 0x01 stdout, 0x02 stderr — and ended by 0x03 and the
 * exit code. Bytes 0x01–0x03 inside the output itself would be misread, so
 * binary data travels by the file endpoints instead.
 */
export function parseExec(body: Uint8Array): { status: number; stdout: string; stderr: string } {
  const out: number[] = [];
  const err: number[] = [];
  let into = out;
  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    if (b === STDOUT) into = out;
    else if (b === STDERR) into = err;
    else if (b === EXIT) return { status: body[i + 1] ?? 1, stdout: Buffer.from(out).toString("utf8"), stderr: Buffer.from(err).toString("utf8") };
    else into.push(b);
  }
  // The stream ended without an exit code: the command was cut off.
  return { status: 1, stdout: Buffer.from(out).toString("utf8"), stderr: Buffer.from(err).toString("utf8") };
}

/**
 * The Sprites REST API, for a server: no CLI, no terminal. `attach` is not
 * supported — a server has no one to attach.
 */
export function spriteApi(token: string, deps: { base?: string; fetch?: typeof fetch } = {}): SpriteCli {
  const base = deps.base ?? "https://api.sprites.dev";
  const f = deps.fetch ?? fetch;
  const call = async (method: string, path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await f(`${base}${path}`, { ...init, method, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(`Sprites API ${method} ${path.split("?")[0]} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return res;
  };
  const sprite = (name: string) => `/v1/sprites/${encodeURIComponent(name)}`;

  return {
    async create(name) {
      await call("POST", "/v1/sprites", { headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    },
    async destroy(name) {
      await call("DELETE", sprite(name));
    },
    async exec(name, script, args = [], opts = {}) {
      if (opts.attach) throw new Error("a server cannot attach to a Sprite's terminal");
      // The same shape as the CLI's: a login shell, so the Sprite's profile
      // applies, with arguments as "$1"…, never as script text.
      const query = new URLSearchParams();
      for (const part of ["bash", "-lc", script, "sfo", ...args]) query.append("cmd", part);
      if (opts.input !== undefined) query.set("stdin", "true");
      const res = await call("POST", `${sprite(name)}/exec?${query}`, {
        headers: { "content-type": "application/octet-stream" },
        body: opts.input ?? "",
      });
      const r = parseExec(new Uint8Array(await res.arrayBuffer()));
      return { status: r.status, stdout: r.status === 0 ? r.stdout : `${r.stdout}${r.stderr}` };
    },
    async pull(name, remote, local) {
      const res = await call("GET", `${sprite(name)}/fs/read?${new URLSearchParams({ path: remote })}`);
      fs.writeFileSync(local, new Uint8Array(await res.arrayBuffer()));
    },
    async push(name, local, remote) {
      await call("PUT", `${sprite(name)}/fs/write?${new URLSearchParams({ path: remote, mkdir: "true" })}`, {
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(fs.readFileSync(local)),
      });
    },
  };
}
