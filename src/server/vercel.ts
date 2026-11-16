import { createHash } from "node:crypto";

/**
 * The few Vercel REST calls a web deploy needs (WEB_AND_MOBILE_SPEC §4), with
 * the person's token. Injectable, so deploys are tested without the network.
 */
export interface VercelApi {
  /** The account a token belongs to, or an error if Vercel refuses it. */
  whoami(token: string): Promise<string>;
  /** The project named so, created when it does not exist. */
  ensureProject(token: string, name: string): Promise<{ id: string; name: string }>;
  /** Sets env vars on a project's production, replacing earlier values. */
  setEnv(token: string, projectId: string, env: Record<string, string>): Promise<void>;
  /** Uploads one file's bytes, keyed by their SHA-1. */
  uploadFile(token: string, bytes: Buffer): Promise<{ sha: string; size: number }>;
  /** Starts a production deployment of files already uploaded. */
  deploy(token: string, project: { id: string; name: string }, files: { file: string; sha: string; size: number }[], framework: string | null): Promise<{ id: string }>;
  /** How a deployment stands, and its public addresses once ready. */
  deployment(token: string, id: string): Promise<{ state: string; aliases: string[]; url: string; error: string | null }>;
}

const API = "https://api.vercel.com";

async function call(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !(body instanceof Buffer) ? { "content-type": "application/json" } : {}), ...headers },
    ...(body === undefined ? {} : { body: body instanceof Buffer ? new Uint8Array(body) : JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Some answers have no body.
  }
  return { status: res.status, json };
}

function vercelError(what: string, r: { status: number; json: Record<string, unknown> }): Error {
  const message = (r.json.error as { message?: string } | undefined)?.message;
  return new Error(`Vercel refused to ${what} (${r.status})${message ? `: ${message}` : ""}`);
}

export const vercel: VercelApi = {
  async whoami(token) {
    const r = await call(token, "GET", "/v2/user");
    if (r.status !== 200) throw vercelError("accept the token", r);
    const user = r.json.user as { username?: string; email?: string } | undefined;
    return user?.username ?? "your account";
  },

  async ensureProject(token, name) {
    const found = await call(token, "GET", `/v9/projects/${encodeURIComponent(name)}`);
    if (found.status === 200) return { id: String(found.json.id), name: String(found.json.name) };
    const made = await call(token, "POST", "/v11/projects", { name });
    if (made.status !== 200) throw vercelError(`create the project ${name}`, made);
    return { id: String(made.json.id), name: String(made.json.name) };
  },

  async setEnv(token, projectId, env) {
    const entries = Object.entries(env).map(([key, value]) => ({ key, value, type: "encrypted", target: ["production"] }));
    if (entries.length === 0) return;
    const r = await call(token, "POST", `/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true`, entries);
    const failed = (r.json.failed as { error?: { message?: string } }[] | undefined) ?? [];
    if (r.status >= 300 || failed.length > 0) throw new Error(`Vercel did not set the environment: ${failed[0]?.error?.message ?? r.status}`);
  },

  async uploadFile(token, bytes) {
    const sha = createHash("sha1").update(bytes).digest("hex");
    const r = await call(token, "POST", "/v2/files", bytes, { "content-type": "application/octet-stream", "x-vercel-digest": sha, "content-length": String(bytes.length) });
    if (r.status !== 200) throw vercelError("take a file", r);
    return { sha, size: bytes.length };
  },

  async deploy(token, project, files, framework) {
    const r = await call(token, "POST", "/v13/deployments?skipAutoDetectionConfirmation=1&forceNew=1", {
      name: project.name,
      project: project.id,
      target: "production",
      files,
      // Without a framework Vercel is left to detect one from the files.
      projectSettings: framework ? { framework } : {},
    });
    if (r.status !== 200) throw vercelError("start the deployment", r);
    return { id: String(r.json.id) };
  },

  async deployment(token, id) {
    const r = await call(token, "GET", `/v13/deployments/${encodeURIComponent(id)}`);
    if (r.status !== 200) throw vercelError("say how the deployment is going", r);
    const error = (r.json.errorMessage as string | undefined) ?? (r.json.aliasError as { message?: string } | null)?.message ?? null;
    return { state: String(r.json.readyState ?? ""), aliases: ((r.json.alias as string[] | undefined) ?? []).map(String), url: String(r.json.url ?? ""), error };
  },
};
