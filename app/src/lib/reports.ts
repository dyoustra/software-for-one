/**
 * Reports arrive as text written for a terminal (`sfo decisions`, `sfo
 * criteria`) or as Markdown (SUMMARY.md). These turn them into structure the
 * app can set as typography. Each returns null for text it does not
 * recognise, and the screen shows the text as it is.
 */

/** Inline runs of a Markdown line: plain, **strong** or `code`. */
export type Inline = { text: string; style?: 'strong' | 'code' };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: Inline[] }
  | { kind: 'paragraph'; text: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; text: string };

export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    const token = m[0];
    // Code inside bold keeps the bold and loses only its backticks.
    out.push(token.startsWith('**') ? { text: token.slice(2, -2).replace(/`/g, ''), style: 'strong' } : { text: token.slice(1, -1), style: 'code' });
    last = m.index + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** The subset of Markdown sfo's reports use: headings, paragraphs, lists, fenced code, bold, inline code. */
export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: inline(paragraph.join(' ')) });
    paragraph = [];
    if (list) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(inline) });
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3, text: inline(heading[2]) });
    } else if (bullet || numbered) {
      const ordered = !bullet;
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (!line.trim()) {
      flush();
    } else if (list && /^\s{2,}\S/.test(line)) {
      // A wrapped list item continues the item above it.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

export interface Decision {
  id: string;
  scope: string;
  byHuman: boolean;
  title: string;
  chose: string;
  why: string;
}

/** `sfo decisions`: blocks led by `D-001  [scope]  decided by agent|human`. */
export function parseDecisions(text: string): Decision[] | null {
  const out: Decision[] = [];
  for (const block of text.trim().split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const head = lines[0]?.match(/^(D-\d+)\s+\[([^\]]+)\]\s+decided by (\w+)/);
    if (!head) continue;
    const field = (name: string) =>
      lines
        .find((l) => l.trim().startsWith(`${name}:`))
        ?.trim()
        .slice(name.length + 1)
        .trim() ?? '';
    out.push({ id: head[1], scope: head[2], byHuman: head[3] === 'human', title: lines[1]?.trim() ?? '', chose: field('chose'), why: field('why') });
  }
  return out.length ? out : null;
}

export interface CriteriaGroup {
  name: string;
  items: { id: string; text: string }[];
}

/** `sfo criteria`: an unindented group name, then indented `AC-001   text` lines (wrapped lines continue). */
export function parseCriteria(text: string): CriteriaGroup[] | null {
  const groups: CriteriaGroup[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const item = line.match(/^\s+(AC-\d+)\s+(.*)$/);
    if (item) {
      if (!groups.length) groups.push({ name: '', items: [] });
      groups[groups.length - 1].items.push({ id: item[1], text: item[2].trim() });
    } else if (/^\S/.test(line)) {
      groups.push({ name: line.trim(), items: [] });
    } else {
      const items = groups[groups.length - 1]?.items;
      if (items?.length) items[items.length - 1].text += ` ${line.trim()}`;
    }
  }
  return groups.some((g) => g.items.length) ? groups.filter((g) => g.items.length) : null;
}
