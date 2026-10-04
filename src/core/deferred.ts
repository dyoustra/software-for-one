import { readSmokeRecords, latestSmoke } from "./smoke.js";
import { readInstall } from "./install.js";
import { readRenders } from "./presentation.js";
import { readContractFile } from "./contracts.js";
import type { Env } from "./paths.js";

export interface Deferred {
  /** Everything these checks need, once each, in the contract's words. */
  needs: string[];
  seams: string[];
  renders: number;
  install: boolean;
}

/**
 * What an unattended run left for the person: checks that need hardware, a
 * device, or someone to look. Never throws — it feeds `sfo status`.
 */
export function deferredWork(id: string, env?: Env): Deferred {
  const out: Deferred = { needs: [], seams: [], renders: 0, install: false };
  const needs = new Set<string>();
  try {
    const contract = readContractFile(id, env);
    const smokeNeeds = new Map((contract?.smoke ?? []).map((e) => [e.name, e.needs]));
    out.seams = [...new Set(latestSmoke(readSmokeRecords(id, env)).filter((r) => r.level === "deferred").map((r) => r.seam))];
    for (const seam of out.seams) for (const n of smokeNeeds.get(seam) ?? []) needs.add(n);
    const renders = readRenders(id, env).filter((r) => r.deferred);
    out.renders = renders.length;
    for (const r of renders) for (const n of r.deferred ?? []) needs.add(n);
    const install = readInstall(id, env);
    if (install?.deferred) {
      out.install = true;
      for (const n of install.deferred) needs.add(n);
    }
  } catch {
    // Nothing readable: nothing to report as waiting.
  }
  out.needs = [...needs];
  return out;
}

export function hasDeferred(d: Deferred): boolean {
  return d.seams.length + d.renders > 0 || d.install;
}

/**
 * The commands \`sfo check\` would run for this deferred work, as the project
 * declared them. Shown before running a project that was built somewhere
 * else: they run here, with this person's rights.
 */
export function deferredCommands(id: string, env?: Env): string[] {
  const work = deferredWork(id, env);
  const contract = readContractFile(id, env);
  // Without a contract, sfo falls back to a built-in installer (npm link, uv
  // tool install) whose effect cannot be shown as a command. A project built
  // elsewhere must declare what runs, or nothing does.
  if (!contract) throw new Error(`${id} declares no CONTRACTS.json, so what its checks would run here cannot be shown — not running them`);
  const out: string[][] = [];
  if (work.install && contract.install) out.push(contract.install.run, ...contract.install.check);
  // Capturing the deferred renders captures every declared one; with none
  // declared, capture falls back to PRESENTATION.json's invocations, which
  // this list would not show.
  if (work.renders > 0 && contract.render.length === 0) {
    throw new Error(`${id} has renders waiting but declares none in CONTRACTS.json, so what would run here cannot be shown — not running them`);
  }
  if (work.renders > 0) for (const r of contract.render) out.push(r.run);
  for (const e of contract.smoke) if (work.seams.includes(e.name)) out.push(e.run);
  return out.map(shown);
}

const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * An argument list as it can be read and trusted. The project wrote it: an
 * escape sequence, a newline, a right-to-left override or a zero-width
 * character could make the line look like something else. So anything not
 * plain is quoted, and every character outside printable ASCII is spelled out.
 */
export function shown(argv: string[]): string {
  return argv
    .map((a) =>
      PLAIN.test(a)
        ? a
        : `"${a.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`,
    )
    .join(" ");
}
