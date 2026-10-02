import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { artifactPath, projectDir, type Env } from "./paths.js";
import { walkTestTree } from "./testlock.js";
import type { VerifyStep } from "./archetype.js";

export const CONTRACTS_FILE = "CONTRACTS.json";

/** An argument list, run with no shell: paths and ids must stay data. */
const Argv = z.array(z.string().min(1)).min(1);

/** Anything a check needs that an unattended run may not have: "hardware: MagTag on USB". */
const Needs = z.array(z.string().min(1)).default([]);

const GateStepSchema = z.object({
  name: z.string().min(1),
  run: Argv,
  /**
   * Scopes the step to one slice: a glob relative to the project, where
   * `{slice}` stands for the slice id in the loose form test files spell it
   * (S-01 as s01, s-01 or S_01). Those files go on the end of `run`.
   */
  files: z.string().min(1).optional(),
});

export const ContractSchema = z.object({
  /** In order. The gate must run anywhere, so a gate step may need nothing. */
  gate: z.array(GateStepSchema).min(1),
  install: z
    .object({
      run: Argv,
      /** Each must exit 0 from a new login shell once installed. */
      check: z.array(Argv).default([]),
      needs: Needs,
    })
    .optional(),
  render: z
    .array(
      z.object({
        name: z.string().min(1),
        run: Argv,
        /** Files the command writes, relative to the project, to keep and show. */
        produces: z.array(z.string().min(1)).default([]),
        needs: Needs,
      }),
    )
    .default([]),
  smoke: z
    .array(
      z.object({
        /** The seam's id in SERVICES.jsonl, when it exercises one. */
        name: z.string().min(1),
        run: Argv,
        needs: Needs,
      }),
    )
    .default([]),
});

export type Contract = z.infer<typeof ContractSchema>;
export type GateStep = z.infer<typeof GateStepSchema>;

/**
 * The project's own contract. Written by test-repair and locked with the
 * tests, so a build agent cannot loosen how it is graded.
 */
export function readContractFile(id: string, env?: Env): Contract | null {
  const file = artifactPath(id, CONTRACTS_FILE, env);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${CONTRACTS_FILE} is not valid JSON`);
  }
  const parsed = ContractSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid ${CONTRACTS_FILE}: ${parsed.error.message}`);
  if (!parsed.data.gate.some((s) => s.files !== undefined)) {
    throw new Error(`invalid ${CONTRACTS_FILE}: no gate step is scoped to a slice's files, so no slice would be tested`);
  }
  return parsed.data;
}

/** The regex fragment for a slice id in a file name, as test files loosely spell it. */
function sliceFragment(sliceId: string): string {
  const runs = sliceId.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return `${runs.join("[^a-z0-9]*")}(?![0-9])`;
}

/**
 * A `files` glob as a regex over project-relative paths. `**` crosses
 * directories, `*` does not, and `{slice}` is the loose slice id — or, for
 * `anySlice`, anything at all, which is how a follow-up's own tests are
 * matched to the step that runs them.
 */
export function globRegex(glob: string, sliceId: string | null): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const rest = glob.slice(i);
    if (rest.startsWith("{slice}")) {
      out += sliceId === null ? ".*" : sliceFragment(sliceId);
      i += "{slice}".length - 1;
    } else if (rest.startsWith("**/")) {
      out += "(?:.*/)?";
      i += 2;
    } else if (rest.startsWith("**")) {
      out += ".*";
      i += 1;
    } else if (glob[i] === "*") {
      out += "[^/]*";
    } else {
      out += glob[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

/** The fixed directory a glob starts in: where to walk, so the walk stays out of node_modules. */
function globRoot(glob: string): string {
  const parts = glob.split("/");
  const fixed: string[] = [];
  for (const p of parts.slice(0, -1)) {
    if (/[*{]/.test(p)) break;
    fixed.push(p);
  }
  return fixed.join("/");
}

/** The files a scoped step runs for one slice. */
export function filesFor(id: string, step: VerifyStep, sliceId: string, env?: Env): string[] {
  if (!step.files) return [];
  const root = globRoot(step.files);
  const regex = globRegex(step.files, sliceId);
  return walkTestTree(path.join(projectDir(id, env), root))
    .map((rel) => (root ? `${root}/${rel}` : rel))
    .filter((rel) => regex.test(rel));
}

/** Whether a path belongs to a scoped step for some slice — for tests no slice owns. */
export function stepCovers(step: VerifyStep, file: string): boolean {
  return step.files !== undefined && globRegex(step.files, null).test(file);
}

export function gateSteps(contract: Contract): VerifyStep[] {
  return contract.gate.map((s) => ({
    name: s.name,
    command: s.run[0],
    args: s.run.slice(1),
    scopeable: s.files !== undefined,
    ...(s.files ? { files: s.files } : {}),
  }));
}

/** Every program the contract runs, by name: the toolchain an agent needs. */
export function contractCommands(contract: Contract): string[] {
  return [
    ...contract.gate.map((s) => s.run[0]),
    ...(contract.install ? [contract.install.run[0], ...contract.install.check.map((c) => c[0])] : []),
    ...contract.render.map((r) => r.run[0]),
    ...contract.smoke.map((r) => r.run[0]),
  ];
}

