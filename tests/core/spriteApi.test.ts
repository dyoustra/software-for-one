import { describe, it, expect } from "vitest";
import { parseExec, spriteApi } from "../../src/core/spriteApi.js";

const frames = (...parts: (number | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === "number" ? [p] : [...Buffer.from(p)])));

describe("the exec stream", () => {
  it("splits stdout from stderr and reads the exit code", () => {
    // As the API answered `echo out; echo err >&2; cat; exit 3` with stdin.
    expect(parseExec(frames(2, "err\n", 1, "out\n", 1, "from-stdin", 3, 3))).toEqual({ status: 3, stdout: "out\nfrom-stdin", stderr: "err\n" });
  });

  it("calls a stream with no exit code a failure", () => {
    expect(parseExec(frames(1, "partial")).status).toBe(1);
  });
});

describe("spriteApi", () => {
  it("runs a script in a login shell with its arguments as positional parameters, and stdin in the body", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(frames(1, "ok", 3, 0));
    }) as typeof fetch;
    const api = spriteApi("tok", { base: "https://sprites.test", fetch: fake });

    const r = await api.exec("sfo-1", 'cat > "$1"', ["claude-token"], { input: "secret" });

    expect(r).toEqual({ status: 0, stdout: "ok" });
    const url = new URL(seen[0].url);
    expect(url.pathname).toBe("/v1/sprites/sfo-1/exec");
    expect(url.searchParams.getAll("cmd")).toEqual(["bash", "-lc", 'cat > "$1"', "sfo", "claude-token"]);
    expect(url.searchParams.get("stdin")).toBe("true");
    expect(seen[0].url).not.toContain("secret");
    expect(seen[0].init.body).toBe("secret");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("says which call failed and how", async () => {
    const fake = (async () => new Response("no such sprite", { status: 404 })) as unknown as typeof fetch;
    await expect(spriteApi("tok", { fetch: fake }).destroy("sfo-x")).rejects.toThrow(/DELETE \/v1\/sprites\/sfo-x failed \(404\)/);
  });

  it("refuses to attach: a server has no terminal", async () => {
    await expect(spriteApi("tok").exec("sfo-1", "true", [], { attach: true })).rejects.toThrow(/cannot attach/);
  });
});
