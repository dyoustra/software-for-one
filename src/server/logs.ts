import type { LogPage } from "../api/types.js";
import { parseEvent } from "../commands/logs.js";

/** The records a project's results are read from, each at most this many bytes. */
export const RESULT_FILES = ["state.json", "PRIOR_ART.json", "DELIVERY.json", "INSTALL.json", "COST.jsonl", "SLICES.jsonl", "VERIFY.jsonl", "CRITERIA.jsonl"];
const FILE_BYTES = 2 * 1024 * 1024;
const FILE_MARK = "--sfo-file--";

/**
 * Prints each of the project's records that exists, after a marker naming it.
 * Plain shell, like the log script, so any Sprite can answer. Symlinks are
 * skipped, here and in the log script: an agent could point one anywhere.
 */
export const RESULTS_SCRIPT = `
d="\${SFO_HOME:-$HOME/.sfo}/$1/.sfo"
for f in ${RESULT_FILES.join(" ")}; do
  if [ -f "$d/$f" ] && [ ! -L "$d/$f" ]; then printf '\\n%s %s\\n' "${FILE_MARK}" "$f"; head -c ${FILE_BYTES} "$d/$f"; fi
done
`;

/** The script's output as file name and contents; anything not on the list is ignored. */
export function parseResultFiles(stdout: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const part of stdout.split(`\n${FILE_MARK} `).slice(1)) {
    const nl = part.indexOf("\n");
    const name = part.slice(0, nl);
    if (RESULT_FILES.includes(name)) files.set(name, part.slice(nl + 1));
  }
  return files;
}

/** The most a page reads, so a stage that logged a huge tool output cannot stall a phone. */
export const PAGE_BYTES = 256 * 1024;
/** Without a starting point, a page is the end of the log: this much of it. */
export const TAIL_BYTES = 64 * 1024;

/** A stage log's name: a stage, or a stage and slice (`build-S-02`). Never a path. */
export const STAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

const SEPARATOR = "--sfo-log--";

/**
 * Runs on the project's Sprite, so a page is one round trip: lists the stage
 * logs in the order written (verify logs aside), picks the stage asked for or
 * the latest, and prints the slice of it the page covers. Arguments: project
 * id, stage (or empty), first byte (or empty, for the tail), byte limit, tail
 * size. Plain POSIX shell, so a Sprite with any sfo version can answer.
 */
export const LOG_PAGE_SCRIPT = `
project="\${SFO_HOME:-$HOME/.sfo}/$1"
cd "$project/.sfo/logs" 2>/dev/null || { echo "$project"; echo "${SEPARATOR}"; exit 0; }
echo "$project"
last=""
for f in $(ls -tr -- *.log 2>/dev/null); do
  case "$f" in *.verify.log) continue ;; esac
  [ -L "$f" ] && continue
  printf '%s\\t%s\\n' "\${f%.log}" "$(wc -c < "$f" | tr -d ' ')"
  last="\${f%.log}"
done
echo "${SEPARATOR}"
stage="\${2:-$last}"
[ -n "$stage" ] && [ -f "$stage.log" ] && [ ! -L "$stage.log" ] || exit 0
size=$(wc -c < "$stage.log" | tr -d ' ')
from="$3"
if [ -z "$from" ]; then from=$(( size > $5 ? size - $5 : 0 )); fi
printf '%s\\t%s\\n' "$stage" "$from"
tail -c +$((from + 1)) "$stage.log" | head -c "$4"
`;

/**
 * The script's output as a page: whole lines only, parsed into events. When
 * the page began at a tail the script chose (`tailed`), its first line is
 * likely a fragment and is dropped. A stage asked for that is not among the
 * logs reads as no page at all.
 */
export function parseLogPage(stdout: string, opts: { tailed: boolean; askedFor?: string }): LogPage | null {
  const cut = stdout.indexOf(`\n${SEPARATOR}\n`);
  const head = (cut >= 0 ? stdout.slice(0, cut) : stdout).split("\n");
  const project = head[0] ?? "";
  const stages = head
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const [name, size] = l.split("\t");
      return { name, size: Number(size) || 0 };
    });
  if (opts.askedFor && !stages.some((s) => s.name === opts.askedFor)) return null;

  const rest = cut >= 0 ? stdout.slice(cut + SEPARATOR.length + 2) : "";
  const nl = rest.indexOf("\n");
  if (!rest || nl < 0) return { stages, stage: null, from: 0, to: 0, events: [] };
  const [stage, fromText] = rest.slice(0, nl).split("\t");
  const from = Number(fromText) || 0;
  let body = rest.slice(nl + 1);
  let skipped = 0;
  if (opts.tailed && from > 0) {
    const first = body.indexOf("\n");
    skipped = first < 0 ? body.length : first + 1;
    body = body.slice(skipped);
  }
  const whole = body.slice(0, body.lastIndexOf("\n") + 1);
  // Paths print relative to the project: the init event that would say where
  // it is may be in an earlier page.
  const state = { cwd: project };
  return {
    stages,
    stage,
    from,
    to: from + Buffer.byteLength(rest.slice(nl + 1, nl + 1 + skipped)) + Buffer.byteLength(whole),
    events: whole.split("\n").flatMap((line) => parseEvent(line, state)),
  };
}
