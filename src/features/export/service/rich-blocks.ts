// Question text (the Markdown plus $...$ / $$...$$ subset of rich-text.ts) as format-neutral
// blocks, for renderers that do not take HTML (the PDF). It follows renderRich rule for rule:
// the same math splitter, the same inline-text rules (it reads the HTML that `inlineText`
// writes, so bold, italic and unit exponents cannot drift), the same paragraph and break rules.
// Nothing is escaped or stripped here: the renderer decides what its output format can carry.
import { splitMath } from "@/components/math/split-math";
import { inlineText } from "./rich-text";

export type RichRun =
  | { kind: "text"; text: string; bold: boolean; italic: boolean; sup: boolean }
  | { kind: "math"; source: string }
  | { kind: "break" };

export type RichBlock =
  { kind: "paragraph"; runs: RichRun[] } | { kind: "display"; source: string };

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

// inlineText escapes every `<`, so the only tags in its output are the four it writes itself.
const TOKEN = /<(\/?)(strong|em|sup)>|<br>|[^<]+/g;

/** Raw text to runs, through the same transformation the HTML renderer applies. */
function inlineRuns(raw: string): RichRun[] {
  const runs: RichRun[] = [];
  let bold = 0;
  let italic = 0;
  let sup = 0;
  for (const match of inlineText(raw).matchAll(TOKEN)) {
    const [whole, closing, tag] = match;
    if (!whole.startsWith("<")) {
      runs.push({
        kind: "text",
        text: whole.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]),
        bold: bold > 0,
        italic: italic > 0,
        sup: sup > 0,
      });
    } else if (whole === "<br>") {
      runs.push({ kind: "break" });
    } else {
      const delta = closing === "/" ? -1 : 1;
      if (tag === "strong") bold += delta;
      else if (tag === "em") italic += delta;
      else sup += delta;
    }
  }
  return runs;
}

/** Breaks at either end go; so do the spaces at the ends (HTML collapses them, a PDF would not). */
function trimParagraph(runs: RichRun[]): RichRun[] {
  const trimmed = [...runs];
  const dropBlank = (end: "start" | "end"): void => {
    for (;;) {
      const index = end === "start" ? 0 : trimmed.length - 1;
      const run = trimmed.at(index);
      if (run === undefined || run.kind === "math") return;
      if (run.kind === "text") {
        const text = end === "start" ? run.text.trimStart() : run.text.trimEnd();
        if (text !== "") {
          trimmed[index] = { ...run, text };
          return;
        }
      }
      trimmed.splice(index, 1);
    }
  };
  dropBlank("start");
  dropBlank("end");
  return trimmed;
}

/**
 * Markdown/LaTeX text to blocks. With `inline` the result is at most one paragraph (an option's
 * text): paragraphs are joined with a break and a display formula stays inline.
 */
export function parseRich(md: string, inline = false): RichBlock[] {
  const blocks: RichBlock[] = [];
  let runs: RichRun[] = [];
  const flush = () => {
    const paragraph = trimParagraph(runs);
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", runs: paragraph });
    runs = [];
  };
  for (const segment of splitMath(md.replace(/\r\n?/g, "\n").trim())) {
    if (segment.kind === "text") {
      segment.value.split(/\n{2,}/).forEach((part, index) => {
        if (index > 0) flush();
        runs.push(...inlineRuns(part));
      });
    } else if (segment.kind === "inline" || inline) {
      runs.push({ kind: "math", source: segment.value });
    } else {
      flush();
      blocks.push({ kind: "display", source: segment.value });
    }
  }
  flush();
  if (!inline) return blocks;
  const joined: RichRun[] = [];
  for (const block of blocks) {
    if (block.kind !== "paragraph") continue;
    if (joined.length > 0) joined.push({ kind: "break" });
    joined.push(...block.runs);
  }
  return joined.length > 0 ? [{ kind: "paragraph", runs: joined }] : [];
}
