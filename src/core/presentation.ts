import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { artifactPath, projectDir, sfoDir, type Env } from "./paths.js";
import { readContractFile, type Contract } from "./contracts.js";

export const PRESENTATION_FILE = "PRESENTATION.json";
export const RENDERS_FILE = "RENDERS.json";
export const RENDERS_DIR = "renders";

/**
 * How a tool shows itself, decided per project by the spec stage: not every
 * CLI has a look worth checking, and a screenshot of a file converter proves
 * nothing a test does not.
 */
export const PresentationSchema = z.object({
  kind: z.enum(["visual", "text", "none"]),
  why: z.string().min(1),
  /** Deterministic runs that show the tool doing its main job: argv, command first. */
  invocations: z.array(z.array(z.string().min(1)).min(1)).max(6).default([]),
});
export type Presentation = z.infer<typeof PresentationSchema>;

export function readPresentation(id: string, env?: Env): Presentation | null {
  const file = artifactPath(id, PRESENTATION_FILE, env);
  if (!fs.existsSync(file)) return null;
  return PresentationSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export interface Render {
  invocation: string[];
  /** Files a declared render produced, kept under `.sfo/renders/`. */
  images?: string[];
  /** What it needs that the run did not have, when it was left for later. */
  deferred?: string[];
  /** The raw capture, ANSI included, relative to `.sfo/`. */
  text?: string;
  /** Screenshots on a light and a dark terminal background, relative to `.sfo/`. */
  light?: string;
  dark?: string;
  error?: string;
}

export type Run = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => {
  status: number | null;
  stdout: Buffer;
  stderr: string;
};

const run: Run = (command, args, { cwd, env, timeoutMs }) => {
  // stdin closed: `script` refuses a pipe for its own input ("tcgetattr:
  // Operation not supported on socket") but takes /dev/null.
  const r = spawnSync(command, args, { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: `${r.stderr ?? ""}${r.error?.message ?? ""}` };
};

/** How to run a project's own command from inside it, installed or not. */
function projectCommand(archetype: string, argv: string[]): string[] | null {
  if (archetype === "cli-python") return ["uv", "run", ...argv];
  if (archetype === "cli-node") return ["npx", "--no-install", ...argv];
  return null;
}

/**
 * `script` echoes the end of its closed stdin as the two characters "^D" and
 * two backspaces before the output, and every newline arrives as CRLF.
 */
export function cleanCapture(raw: Buffer): string {
  return raw.toString("utf8").replace(/^(\^D)?\u0008\u0008/, "").replace(/\r\n/g, "\n");
}

/**
 * Runs each invocation on a real pseudo-terminal, as a person's terminal
 * would, and keeps what it printed. For a `visual` tool, each capture is also
 * drawn onto a light and a dark terminal background: the check a snapshot test
 * cannot make, since a colour that vanishes on one background is right to the
 * byte and still invisible.
 */
export function captureRenders(id: string, archetype: string, env: Env = process.env, runWith: Run = run): Render[] {
  const declared = readContractFile(id, env)?.render ?? [];
  if (declared.length > 0) return captureDeclared(id, declared, env, runWith);
  const presentation = readPresentation(id, env);
  if (!presentation || presentation.kind === "none") return [];
  const dir = projectDir(id, env);
  const outDir = path.join(sfoDir(id, env), RENDERS_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const ptyEnv = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", COLUMNS: "80", LINES: "40" };

  const renders: Render[] = [];
  presentation.invocations.forEach((argv, i) => {
    const n = i + 1;
    const render: Render = { invocation: argv };
    const command = projectCommand(archetype, argv);
    if (!command) {
      renders.push({ ...render, error: `no way to run a "${archetype}" command` });
      return;
    }
    const captured = runWith("script", ["-q", "/dev/null", ...command], { cwd: dir, env: ptyEnv, timeoutMs: 120_000 });
    const text = cleanCapture(captured.stdout);
    fs.writeFileSync(path.join(outDir, `${n}.txt`), text);
    render.text = `${RENDERS_DIR}/${n}.txt`;
    if (captured.status !== 0) render.error = `exited ${captured.status ?? "abnormally"}${captured.stderr ? `: ${captured.stderr.split("\n")[0]}` : ""}`;

    if (presentation.kind === "visual") {
      const drawn = drawScreenshots(path.join(outDir, `${n}.txt`), path.join(outDir, `${n}`), runWith);
      if (drawn.ok) {
        render.light = `${RENDERS_DIR}/${n}-light.png`;
        render.dark = `${RENDERS_DIR}/${n}-dark.png`;
      } else {
        render.error = [render.error, `screenshots not drawn: ${drawn.detail}`].filter(Boolean).join("; ");
      }
    }
    renders.push(render);
  });
  fs.writeFileSync(artifactPath(id, RENDERS_FILE, env), `${JSON.stringify(renders, null, 2)}\n`);
  return renders;
}

/**
 * The project's own renders: commands that produce something to look at —
 * screenshots from a browser, a capture of a terminal, a photo from a board.
 * What a command prints is kept as text; the files it says it produces are
 * copied beside it for review to open and the summary to show.
 */
function captureDeclared(id: string, declared: Contract["render"], env: Env, runWith: Run): Render[] {
  const dir = projectDir(id, env);
  const outDir = path.join(sfoDir(id, env), RENDERS_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const renders = declared.map((entry, i): Render => {
    const n = i + 1;
    const render: Render = { invocation: entry.run };
    if (entry.needs.length > 0) return { ...render, deferred: entry.needs };
    const r = runWith(entry.run[0], entry.run.slice(1), { cwd: dir, env: process.env, timeoutMs: 300_000 });
    fs.writeFileSync(path.join(outDir, `${n}.txt`), r.stdout);
    render.text = `${RENDERS_DIR}/${n}.txt`;
    if (r.status !== 0) render.error = `exited ${r.status ?? "abnormally"}${r.stderr ? `: ${r.stderr.split("\n")[0]}` : ""}`;
    const images: string[] = [];
    for (const produced of entry.produces) {
      const source = path.join(dir, produced);
      if (!fs.existsSync(source)) {
        render.error = [render.error, `${produced} was not produced`].filter(Boolean).join("; ");
        continue;
      }
      const name = `${n}-${path.basename(produced)}`;
      fs.copyFileSync(source, path.join(outDir, name));
      images.push(`${RENDERS_DIR}/${name}`);
    }
    if (images.length > 0) render.images = images;
    return render;
  });
  fs.writeFileSync(artifactPath(id, RENDERS_FILE, env), `${JSON.stringify(renders, null, 2)}\n`);
  return renders;
}

function drawScreenshots(capture: string, stem: string, runWith: Run): { ok: boolean; detail: string } {
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-render-")), "render_ansi.py");
  fs.writeFileSync(script, RENDERER);
  const r = runWith("uv", ["run", "--no-project", "--with", "pillow", "python", script, capture, `${stem}-light.png`, `${stem}-dark.png`], {
    cwd: os.tmpdir(),
    env: process.env,
    timeoutMs: 180_000,
  });
  return r.status === 0 ? { ok: true, detail: "" } : { ok: false, detail: r.stderr.split("\n").filter(Boolean).slice(-1)[0] ?? `exit ${r.status}` };
}

/**
 * Draws an ANSI capture as a terminal would, twice. "Default foreground" is
 * the point: it is dark on the light theme and light on the dark one, which is
 * how a tool that hard-codes white disappears on half its users' terminals.
 */
const RENDERER = String.raw`
import re, sys
from PIL import Image, ImageDraw, ImageFont

THEMES = {
    "light": {"bg": (255, 255, 255), "fg": (30, 30, 30)},
    "dark": {"bg": (30, 30, 30), "fg": (212, 212, 212)},
}
BASIC = [(0,0,0),(205,49,49),(13,188,121),(229,229,16),(36,114,200),(188,63,188),(17,168,205),(229,229,229),
         (102,102,102),(241,76,76),(35,209,139),(245,245,67),(59,142,234),(214,112,214),(41,184,219),(255,255,255)]

def xterm(n):
    if n < 16: return BASIC[n]
    if n < 232:
        n -= 16; levels = [0, 95, 135, 175, 215, 255]
        return (levels[n // 36], levels[(n // 6) % 6], levels[n % 6])
    v = 8 + (n - 232) * 10; return (v, v, v)

TOKEN = re.compile(r"\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|([^\x1b]+)")

def cells(text, default):
    lines, line, fg = [], [], None
    for m in TOKEN.finditer(text):
        if m.group(1) is not None:
            codes = [int(c) if c else 0 for c in m.group(1).split(";")]
            i = 0
            while i < len(codes):
                c = codes[i]
                if c in (0, 39): fg = None
                elif 30 <= c <= 37: fg = BASIC[c - 30]
                elif 90 <= c <= 97: fg = BASIC[c - 90 + 8]
                elif c == 38 and i + 2 < len(codes) and codes[i + 1] == 5: fg = xterm(codes[i + 2]); i += 2
                elif c == 38 and i + 4 < len(codes) and codes[i + 1] == 2: fg = tuple(codes[i + 2:i + 5]); i += 4
                i += 1
        elif m.group(2):
            for ch in m.group(2):
                if ch == "\n": lines.append(line); line = []
                elif ch != "\r": line.append((ch, fg))
    lines.append(line)
    while lines and not lines[-1]: lines.pop()
    return lines

def font():
    for path in ("/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"):
        try: return ImageFont.truetype(path, 16)
        except OSError: pass
    return ImageFont.load_default()

def draw(text, out, theme):
    f = font(); w = int(f.getlength("M")) or 9; h = 22; pad = 16
    lines = cells(text, theme["fg"])
    cols = max([len(l) for l in lines] + [20])
    img = Image.new("RGB", (cols * w + 2 * pad, max(1, len(lines)) * h + 2 * pad), theme["bg"])
    d = ImageDraw.Draw(img)
    for y, line in enumerate(lines):
        for x, (ch, fg) in enumerate(line):
            d.text((pad + x * w, pad + y * h), ch, font=f, fill=fg or theme["fg"])
    img.save(out)

text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
draw(text, sys.argv[2], THEMES["light"])
draw(text, sys.argv[3], THEMES["dark"])
`;

export const DRAFTS_DIR = "drafts";

/**
 * Draws each draft spec wrote in `.sfo/drafts/` (`A.txt`, `B.txt`, …) on a
 * light and a dark background, for the person to choose between at clarify.
 * Returns the image paths per draft, relative to `.sfo/`.
 */
export function drawDrafts(id: string, env: Env = process.env, runWith: Run = run): { draft: string; light?: string; dark?: string; error?: string }[] {
  const dir = path.join(sfoDir(id, env), DRAFTS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^[A-Z]\.txt$/.test(f))
    .sort()
    .map((f) => {
      const draft = f.slice(0, -4);
      const drawn = drawScreenshots(path.join(dir, f), path.join(dir, draft), runWith);
      return drawn.ok
        ? { draft, light: `${DRAFTS_DIR}/${draft}-light.png`, dark: `${DRAFTS_DIR}/${draft}-dark.png` }
        : { draft, error: drawn.detail };
    });
}

export function draftImages(id: string, env?: Env): string[] {
  const dir = path.join(sfoDir(id, env), DRAFTS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .sort()
    .map((f) => path.join(dir, f));
}

export function readRenders(id: string, env?: Env): Render[] {
  try {
    return JSON.parse(fs.readFileSync(artifactPath(id, RENDERS_FILE, env), "utf8")) as Render[];
  } catch {
    return [];
  }
}
