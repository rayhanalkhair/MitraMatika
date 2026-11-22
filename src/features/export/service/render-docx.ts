// The Word renderer (ADR-0013): the same document model as the HTML, laid out with the `docx`
// library. Formulas become native Word equations (LaTeX -> KaTeX MathML -> OMML, injected as XML);
// a formula that cannot be converted prints as its LaTeX source in a monospace run and is reported
// as a warning. The text is Indonesian whatever the UI language is.
//
// Safety: `docx` escapes text for XML, but it does not drop the characters XML 1.0 forbids (NUL,
// backspace, lone surrogates...), which would make Word refuse the file. Every string from the
// model goes through xmlSafe before it reaches a run. The package has no macros and no external
// relationship: the only media is the logo, embedded from its bytes.
import "server-only";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  ImageRun,
  ImportedXmlComponent,
  Packer,
  PageNumber,
  Paragraph,
  Tab,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TabStopType,
  TextRun,
  VerticalAlign,
  WidthType,
  type IBorderOptions,
  type IParagraphOptions,
  type IRunOptions,
  type ParagraphChild,
} from "docx";
import JSZip from "jszip";
import { SaxesParser } from "saxes";
import { withDecimalComma } from "@/components/math/decimal-comma";
import { splitMath } from "@/components/math/split-math";
import type { PaperSize, TemplateFont } from "@/features/templates";
import { keyRows, type ExportDocument, type ExportItem } from "./document-model";
import { imageSize } from "./image-size";
import { latexToOmml, LatexToOmmlError } from "./latex-to-omml";
import { formatPoints, type DocumentKind, type RenderOptions } from "./render-html";
import { cutText, xmlSafe } from "./xml";
import type { LogoOmittedWarning } from "./warnings";
import { UNIT_EXPONENT, type RenderWarning, type WarningWhere } from "./rich-text";

/** A math failure (same shape as the HTML renderer's) or a logo Word cannot show. */
export type DocxWarning = RenderWarning | LogoOmittedWarning;
export type { LogoOmittedWarning };

/** Page sizes in twips (1/1440 inch): A4 210 x 297 mm, F4 215 x 330 mm (D-014). */
export const PAGE_TWIPS: Record<PaperSize, { width: number; height: number }> = {
  A4: { width: 11906, height: 16838 },
  F4: { width: 12189, height: 18709 },
};
const FONT_NAMES: Record<TemplateFont, string> = {
  times: "Times New Roman",
  arial: "Arial",
};
const MONO = "Courier New";
// The print CSS margins: 18 mm, 22 mm at the bottom for the footer.
const MARGIN = {
  top: 1020,
  right: 1020,
  bottom: 1247,
  left: 1020,
  header: 567,
  footer: 567,
};
const INDENT = 425; // 7.5 mm: the question number column.
const LOGO_TWIPS = 1134; // 20 mm
const LOGO_PX = 76; // 20 mm at 96 dpi
const ITEM_GAP = 180; // 9 pt after a question
const TITLES: Record<DocumentKind, string> = {
  paper: "Naskah Soal",
  key: "Kunci Jawaban",
  solutions: "Pembahasan",
};

interface Ctx {
  font: string;
  contentWidth: number;
  warnings: DocxWarning[];
  where: WarningWhere;
}

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  superScript?: boolean;
  allCaps?: boolean;
  size?: number;
  mono?: boolean;
  breakBefore?: boolean;
}

function run(ctx: Ctx, text: string, style: RunStyle = {}): TextRun {
  // Typed first: inside `new TextRun(...)` the literal is also read as a string (String.bold).
  const options: IRunOptions = {
    text: xmlSafe(text),
    font: style.mono ? MONO : ctx.font,
    size: style.size ?? 24,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italics ? { italics: true } : {}),
    ...(style.superScript ? { superScript: true } : {}),
    ...(style.allCaps ? { allCaps: true } : {}),
    ...(style.breakBefore ? { break: 1 } : {}),
  };
  return new TextRun(options);
}

const tabRun = (ctx: Ctx): TextRun =>
  new TextRun({ children: [new Tab()], font: ctx.font, size: 24 });

// ---------------------------------------------------------------------------------------------
// Equations

/** The generated package is not valid XML. The message never contains document text. */
export type RenderDocxErrorCode = "render" | "pack" | "image";

// Fixed messages: never a path, document text or a library's own message (those stay in `cause`,
// for server logs only).
const MESSAGES: Record<RenderDocxErrorCode, string> = {
  render: "Word renderer: the document could not be built",
  pack: "Word renderer: the document could not be packaged",
  image: "Word renderer: the logo could not be embedded",
};

export class RenderDocxError extends Error {
  readonly code: RenderDocxErrorCode;

  constructor(code: RenderDocxErrorCode, options?: { cause?: unknown }) {
    super(MESSAGES[code], options);
    this.name = "RenderDocxError";
    this.code = code;
  }
}

function assertWellFormedXml(xml: string): void {
  let failure: unknown = null;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", (error) => {
    failure ??= error;
  });
  parser.write(xml).close();
  if (failure !== null) throw failure as Error;
}

/**
 * Defence in depth against markup reaching the package as markup: word/document.xml must exist and
 * every XML part must be well-formed XML 1.0 (namespaces included). Throws RenderDocxError
 * ("render") otherwise.
 */
export async function assertDocxWellFormed(bytes: Uint8Array): Promise<void> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    if (!zip.file("word/document.xml")) throw new Error("word/document.xml is missing");
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || !/\.(?:xml|rels)$/.test(entry.name)) continue;
      assertWellFormedXml(await entry.async("string"));
    }
  } catch (error) {
    throw new RenderDocxError("render", { cause: error });
  }
}

/**
 * An OMML string as docx XML components (the root's namespace declarations are dropped: the
 * document root declares m: and w: already). saxes hands over DECODED text and attribute values;
 * docx's serializer escapes both again (& < > " '), so `&lt;w:p&gt;` stays text. The
 * "OOXML injection" tests pin that behaviour, and assertDocxWellFormed checks the final package.
 * Exported for those tests.
 */
export function ommlComponent(omml: string): ImportedXmlComponent {
  const stack: ImportedXmlComponent[] = [];
  const roots: ImportedXmlComponent[] = [];
  const parser = new SaxesParser();
  parser.on("error", (error) => {
    throw error;
  });
  parser.on("opentag", (tag) => {
    const attributes = Object.fromEntries(
      Object.entries(tag.attributes).filter(
        ([name]) => stack.length > 0 || !name.startsWith("xmlns"),
      ),
    );
    const element = new ImportedXmlComponent(
      tag.name,
      Object.keys(attributes).length > 0 ? attributes : undefined,
    );
    if (stack.length === 0) roots.push(element);
    else stack[stack.length - 1].push(element);
    stack.push(element);
  });
  parser.on("text", (text) => {
    if (stack.length > 0 && text !== "") stack[stack.length - 1].push(text);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.write(omml).close();
  const root = roots.at(0);
  if (!root) throw new Error("export: empty equation");
  return root;
}

/** A formula as a native equation, or its source in a monospace run plus a warning. */
function formula(
  ctx: Ctx,
  source: string,
  display: boolean,
): { kind: "math"; node: ImportedXmlComponent } | { kind: "fallback"; run: TextRun } {
  try {
    return { kind: "math", node: ommlComponent(latexToOmml(withDecimalComma(source))) };
  } catch (error) {
    // Only a formula the converter refuses becomes a warning; anything else is a bug and fails the
    // render (renderDocxDocument wraps it as "render").
    if (!(error instanceof LatexToOmmlError)) throw error;
    const clean = xmlSafe(source);
    ctx.warnings.push({
      code: "mathFailed",
      where: ctx.where,
      source: cutText(clean, 120),
    });
    const delimiter = display ? "$$" : "$";
    return {
      kind: "fallback",
      run: run(ctx, `${delimiter}${source}${delimiter}`, { mono: true }),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Rich text: the same subset as the HTML (paragraphs, line breaks, **bold**, *italic*, unit
// exponents, inline and display math).

/** One line of text (no newline) to runs: bold, then italic, then unit exponents. */
function lineRuns(ctx: Ctx, line: string, base: RunStyle): TextRun[] {
  const runs: TextRun[] = [];
  const split = (
    text: string,
    pattern: RegExp,
    inner: (part: string, hit: boolean) => void,
  ) => {
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > last) inner(text.slice(last, match.index), false);
      inner(match[1], true);
      last = match.index + match[0].length;
    }
    if (last < text.length) inner(text.slice(last), false);
  };
  split(line, /\*\*([^*\n]+?)\*\*/g, (boldPart, bold) => {
    split(boldPart, /(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, (italicPart, italic) => {
      const style = {
        ...base,
        ...(bold ? { bold: true } : {}),
        ...(italic ? { italics: true } : {}),
      };
      let last = 0;
      for (const match of italicPart.matchAll(UNIT_EXPONENT)) {
        const end = match.index + match[0].length;
        runs.push(run(ctx, italicPart.slice(last, match.index) + match[1], style));
        runs.push(run(ctx, match[2], { ...style, superScript: true }));
        last = end;
      }
      if (last < italicPart.length) runs.push(run(ctx, italicPart.slice(last), style));
    });
  });
  return runs;
}

/** Text with newlines to runs; each newline is a line break. */
function textRuns(ctx: Ctx, text: string, base: RunStyle): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  text.split("\n").forEach((line, index) => {
    if (index > 0) out.push(run(ctx, "", { ...base, breakBefore: true }));
    out.push(...lineRuns(ctx, line, base));
  });
  return out;
}

/** A wrapper element around one imported component (m:oMathPara around m:oMath). */
class ImportedXmlComponentWrapper extends ImportedXmlComponent {
  constructor(name: string, child: ImportedXmlComponent) {
    super(name);
    this.push(child);
  }
}

type Piece = { kind: "text"; value: string } | { kind: "math"; source: string };
type Block =
  | { kind: "text"; children: ParagraphChild[] }
  | { kind: "display"; child: ParagraphChild };

/**
 * Markdown/LaTeX to blocks: text paragraphs and display formulas. With `inline` there is exactly
 * one text block: paragraphs are joined with a line break and display math stays inline (an
 * option's text, a step).
 */
function richBlocks(ctx: Ctx, md: string, base: RunStyle = {}, inline = false): Block[] {
  const blocks: Block[] = [];
  let pieces: Piece[] = [];
  const flush = () => {
    const first = pieces.at(0);
    if (first?.kind === "text") first.value = first.value.replace(/^\n+/, "");
    const last = pieces.at(-1);
    if (last?.kind === "text") last.value = last.value.replace(/\n+$/, "");
    const empty = pieces.every((p) => p.kind === "text" && p.value.trim() === "");
    if (!empty) {
      const children = pieces.flatMap((piece): ParagraphChild[] => {
        if (piece.kind === "text") return textRuns(ctx, piece.value, base);
        const result = formula(ctx, piece.source, false);
        return [result.kind === "math" ? result.node : result.run];
      });
      if (inline && blocks.length > 0 && blocks[0].kind === "text") {
        blocks[0].children.push(
          run(ctx, "", { ...base, breakBefore: true }),
          ...children,
        );
      } else blocks.push({ kind: "text", children });
    }
    pieces = [];
  };
  for (const segment of splitMath(md.replace(/\r\n?/g, "\n").trim())) {
    if (segment.kind === "text") {
      segment.value.split(/\n{2,}/).forEach((part, index) => {
        if (index > 0) flush();
        pieces.push({ kind: "text", value: part });
      });
    } else if (segment.kind === "inline" || inline) {
      pieces.push({ kind: "math", source: segment.value });
    } else {
      flush();
      const result = formula(ctx, segment.value, true);
      blocks.push({
        kind: "display",
        child:
          result.kind === "math"
            ? new ImportedXmlComponentWrapper("m:oMathPara", result.node)
            : result.run,
      });
    }
  }
  flush();
  return blocks;
}

/** Inline rich text (one block's children), for options, steps and table cells. */
function inlineChildren(ctx: Ctx, md: string, base: RunStyle = {}): ParagraphChild[] {
  const block = richBlocks(ctx, md, base, true).at(0);
  return block?.kind === "text" ? block.children : [];
}

/** Paragraphs for rich text; `options(display)` sets each paragraph's layout. */
function richParagraphs(
  ctx: Ctx,
  md: string,
  options: (display: boolean) => Omit<IParagraphOptions, "children">,
  base: RunStyle = {},
): Paragraph[] {
  return richBlocks(ctx, md, base).map((block) =>
    block.kind === "text"
      ? new Paragraph({ ...options(false), children: block.children })
      : new Paragraph({
          ...options(true),
          alignment: AlignmentType.CENTER,
          children: [block.child],
        }),
  );
}

// ---------------------------------------------------------------------------------------------
// Layout pieces

const NONE: IBorderOptions = { style: BorderStyle.NONE, size: 0, color: "auto" };
const SINGLE: IBorderOptions = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
const NO_BORDERS = {
  top: NONE,
  bottom: NONE,
  left: NONE,
  right: NONE,
  insideHorizontal: NONE,
  insideVertical: NONE,
};
const ALL_BORDERS = {
  top: SINGLE,
  bottom: SINGLE,
  left: SINGLE,
  right: SINGLE,
  insideHorizontal: SINGLE,
  insideVertical: SINGLE,
};
const TIGHT = { before: 0, after: 0 };
// Every paragraph of a question (see itemBlocks).
const KEEP = { keepNext: true, keepLines: true };

/** The logo as an image run, or null (SVG: Word needs a raster fallback, none can be made here). */
function logoRun(ctx: Ctx, dataUri: string | null): ImageRun | null {
  if (!dataUri) return null;
  const match = /^data:(image\/(?:png|jpeg|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(
    dataUri,
  );
  const contentType = match?.[1] ?? "unknown";
  const type =
    contentType === "image/png" ? "png" : contentType === "image/jpeg" ? "jpg" : null;
  const bytes = match && type ? new Uint8Array(Buffer.from(match[2], "base64")) : null;
  const size = bytes && type ? imageSize(bytes, type) : null;
  if (!bytes || !type || !size) {
    ctx.warnings.push({
      code: "logoOmitted",
      where: { part: "letterhead" },
      source: contentType,
    });
    return null;
  }
  const scale = LOGO_PX / Math.max(size.width, size.height);
  try {
    return imageRun(type, bytes, size, scale);
  } catch (error) {
    throw new RenderDocxError("image", { cause: error });
  }
}

function imageRun(
  type: "png" | "jpg",
  bytes: Uint8Array,
  size: { width: number; height: number },
  scale: number,
): ImageRun {
  return new ImageRun({
    type,
    data: bytes,
    transformation: {
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
    },
    altText: { name: "Logo", description: "Logo sekolah", title: "Logo" },
  });
}

function letterhead(ctx: Ctx, doc: ExportDocument): Table | null {
  const { lines, schoolName, logoDataUri } = doc.header;
  const logo = logoRun(ctx, logoDataUri);
  const text = [
    ...lines.map(
      (line) =>
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: TIGHT,
          children: [run(ctx, line, { bold: true, allCaps: true, size: 22 })],
        }),
    ),
    ...(schoolName
      ? [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: TIGHT,
            children: [run(ctx, schoolName, { bold: true, size: 28 })],
          }),
        ]
      : []),
  ];
  if (text.length === 0 && !logo) return null;
  const middle = ctx.contentWidth - 2 * LOGO_TWIPS;
  const cell = (width: number, children: Paragraph[]) =>
    new TableCell({
      width: { size: width, type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER,
      children: children.length > 0 ? children : [new Paragraph({ spacing: TIGHT })],
    });
  return new Table({
    width: { size: ctx.contentWidth, type: WidthType.DXA },
    columnWidths: [LOGO_TWIPS, middle, LOGO_TWIPS],
    layout: TableLayoutType.FIXED,
    borders: {
      ...NO_BORDERS,
      bottom: { style: BorderStyle.DOUBLE, size: 6, color: "000000" },
    },
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          cell(
            LOGO_TWIPS,
            logo ? [new Paragraph({ spacing: TIGHT, children: [logo] })] : [],
          ),
          cell(middle, text),
          cell(LOGO_TWIPS, []),
        ],
      }),
    ],
  });
}

const META_TAB = 2268; // 40 mm

function titleBlock(ctx: Ctx, doc: ExportDocument, kind: DocumentKind): Paragraph[] {
  const { meta } = doc;
  const rows: [string, string][] = [
    ["Mata pelajaran", meta.subject],
    ["Kelas", String(meta.grade)],
  ];
  if (meta.examDate) rows.push(["Hari, tanggal", meta.examDate]);
  if (meta.durationMinutes !== null)
    rows.push(["Waktu", `${String(meta.durationMinutes)} menit`]);
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 240, after: 40 },
      keepNext: true,
      children: [run(ctx, TITLES[kind].toUpperCase(), { bold: true, size: 28 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 160 },
      keepNext: true,
      children: [run(ctx, `${meta.title} (${meta.kindLabel})`)],
    }),
    ...rows.map(
      ([label, value], index) =>
        new Paragraph({
          spacing: { before: 0, after: index === rows.length - 1 ? 160 : 0 },
          tabStops: [{ type: TabStopType.LEFT, position: META_TAB }],
          keepNext: true,
          children: [run(ctx, label), tabRun(ctx), run(ctx, `: ${value}`)],
        }),
    ),
  ];
}

function studentBlock(ctx: Ctx, doc: ExportDocument): Paragraph[] {
  return doc.studentFields.map(
    ({ label }) =>
      new Paragraph({
        spacing: { before: 0, after: 80 },
        tabStops: [
          { type: TabStopType.LEFT, position: META_TAB },
          {
            type: TabStopType.RIGHT,
            position: Math.round(ctx.contentWidth * 0.75),
            leader: "dot",
          },
        ],
        children: [run(ctx, label), tabRun(ctx), run(ctx, ":"), tabRun(ctx)],
      }),
  );
}

const BOX = { top: SINGLE, bottom: SINGLE, left: SINGLE, right: SINGLE };

function instructionsBlock(ctx: Ctx, md: string): Paragraph[] {
  ctx.where = { part: "instructions" };
  return [
    new Paragraph({
      border: BOX,
      spacing: { before: 160, after: 0 },
      keepNext: true,
      children: [run(ctx, "Petunjuk:", { bold: true })],
    }),
    ...richParagraphs(ctx, md, () => ({
      border: BOX,
      spacing: { before: 0, after: 60 },
    })),
  ];
}

// ---------------------------------------------------------------------------------------------
// Questions

/** The stem as paragraphs: the number sits in a hanging indent before the first paragraph. */
function stemParagraphs(ctx: Ctx, item: ExportItem): Paragraph[] {
  ctx.where = { part: "stem", number: item.number };
  const blocks = richBlocks(ctx, item.stemMd);
  const number = [run(ctx, `${String(item.number)}.`), tabRun(ctx)];
  if (blocks.length === 0 || blocks[0].kind === "display") {
    blocks.unshift({ kind: "text", children: [] });
  }
  return blocks.map((block, index) => {
    if (block.kind === "display") {
      return new Paragraph({
        ...KEEP,
        alignment: AlignmentType.CENTER,
        indent: { left: INDENT },
        spacing: { before: 60, after: 60 },
        children: [block.child],
      });
    }
    return new Paragraph({
      ...KEEP,
      spacing: { before: 0, after: 60 },
      ...(index === 0
        ? {
            indent: { left: INDENT, hanging: INDENT },
            tabStops: [{ type: TabStopType.LEFT, position: INDENT }],
            children: [...number, ...block.children],
          }
        : { indent: { left: INDENT }, children: block.children }),
    });
  });
}

/** Options in 4, 2 or 1 columns: a borderless table for 4 and 2, paragraphs for 1. */
function optionsBlock(ctx: Ctx, item: ExportItem): (Paragraph | Table)[] {
  const options = item.options ?? [];
  if (options.length === 0) return [];
  const label = 425;
  const optionChildren = (option: { label: string; textMd: string }) => {
    ctx.where = { part: "option", number: item.number, label: option.label };
    return [
      run(ctx, `${option.label}.`),
      tabRun(ctx),
      ...inlineChildren(ctx, option.textMd),
    ];
  };
  if (item.columns === 1) {
    return options.map(
      (option) =>
        new Paragraph({
          ...KEEP,
          indent: { left: INDENT + label, hanging: label },
          tabStops: [{ type: TabStopType.LEFT, position: INDENT + label }],
          spacing: { before: 0, after: 0 },
          children: optionChildren(option),
        }),
    );
  }
  const columns = item.columns;
  const width = ctx.contentWidth - INDENT;
  const cellWidth = Math.floor(width / columns);
  const rows: TableRow[] = [];
  for (let start = 0; start < options.length; start += columns) {
    const slice = options.slice(start, start + columns);
    rows.push(
      new TableRow({
        cantSplit: true,
        children: Array.from({ length: columns }, (_, i) => {
          const option = slice.at(i);
          return new TableCell({
            width: { size: cellWidth, type: WidthType.DXA },
            children: [
              new Paragraph({
                ...KEEP,
                indent: { left: label, hanging: label },
                tabStops: [{ type: TabStopType.LEFT, position: label }],
                spacing: { before: 0, after: 0 },
                children: option ? optionChildren(option) : [],
              }),
            ],
          });
        }),
      }),
    );
  }
  return [
    new Table({
      width: { size: width, type: WidthType.DXA },
      columnWidths: Array.from({ length: columns }, () => cellWidth),
      indent: { size: INDENT, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      margins: { left: 0, right: 115, top: 0, bottom: 0 },
      rows,
    }),
  ];
}

function solutionParagraphs(ctx: Ctx, item: ExportItem): Paragraph[] {
  const correct = item.options?.find((option) => option.label === item.answerMd);
  const answer: ParagraphChild[] = [
    run(ctx, `Jawaban: ${item.answerMd}`, { bold: true }),
  ];
  if (correct) {
    ctx.where = { part: "option", number: item.number, label: correct.label };
    answer.push(
      run(ctx, ". ", { bold: true }),
      ...inlineChildren(ctx, correct.textMd, { bold: true }),
    );
  }
  const stepIndent = 360;
  return [
    new Paragraph({
      ...KEEP,
      indent: { left: INDENT },
      spacing: { before: 40, after: 40 },
      children: answer,
    }),
    ...item.steps.map((step, index) => {
      ctx.where = { part: "step", number: item.number, step: index + 1 };
      return new Paragraph({
        ...KEEP,
        indent: { left: INDENT + stepIndent, hanging: stepIndent },
        tabStops: [{ type: TabStopType.LEFT, position: INDENT + stepIndent }],
        spacing: { before: 0, after: 40 },
        children: [run(ctx, `${String(index + 1)}) `), ...inlineChildren(ctx, step)],
      });
    }),
  ];
}

/**
 * One question kept on one page: every paragraph of it (stem, options, also inside the option
 * table, answer, steps) has keepLines and keepNext, and the question ends with an empty spacer
 * paragraph that has neither. Word then moves the whole question to the next page instead of
 * splitting it.
 */
function itemBlocks(
  ctx: Ctx,
  item: ExportItem,
  kind: DocumentKind,
): (Paragraph | Table)[] {
  const blocks =
    kind === "paper"
      ? [...stemParagraphs(ctx, item), ...optionsBlock(ctx, item)]
      : [...stemParagraphs(ctx, item), ...solutionParagraphs(ctx, item)];
  blocks.push(new Paragraph({ spacing: { before: 0, after: ITEM_GAP - 60 } }));
  return blocks;
}

function keyTable(ctx: Ctx, doc: ExportDocument): Table {
  const rows = keyRows(doc);
  const total = rows.reduce((sum, row) => sum + Math.round(row.points * 100), 0) / 100;
  const widths = [1134, 2268, 1418];
  const cell = (text: string, width: number, bold = false, columnSpan?: number) =>
    new TableCell({
      width: { size: width, type: WidthType.DXA },
      ...(columnSpan ? { columnSpan } : {}),
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: TIGHT,
          children: [run(ctx, text, { bold })],
        }),
      ],
    });
  return new Table({
    alignment: AlignmentType.CENTER,
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders: ALL_BORDERS,
    rows: [
      new TableRow({
        tableHeader: true,
        cantSplit: true,
        children: [
          cell("No", widths[0], true),
          cell("Jawaban", widths[1], true),
          cell("Skor", widths[2], true),
        ],
      }),
      ...rows.map(
        (row) =>
          new TableRow({
            cantSplit: true,
            children: [
              cell(String(row.number), widths[0]),
              cell(row.answer, widths[1]),
              cell(formatPoints(row.points), widths[2]),
            ],
          }),
      ),
      new TableRow({
        cantSplit: true,
        children: [
          cell("Total", widths[0] + widths[1], true, 2),
          cell(formatPoints(total), widths[2], true),
        ],
      }),
    ],
  });
}

function body(ctx: Ctx, doc: ExportDocument, kind: DocumentKind): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  const head = letterhead(ctx, doc);
  if (head) out.push(head);
  out.push(...titleBlock(ctx, doc, kind));
  if (kind === "key") {
    out.push(keyTable(ctx, doc));
    return out;
  }
  if (kind === "paper") {
    out.push(...studentBlock(ctx, doc));
    if (doc.meta.instructionsMd)
      out.push(...instructionsBlock(ctx, doc.meta.instructionsMd));
  }
  for (const section of doc.sections) {
    out.push(
      new Paragraph({
        spacing: { before: 280, after: 60 },
        keepNext: true,
        children: [run(ctx, section.title, { bold: true })],
      }),
    );
    if (section.instructionsMd) {
      ctx.where = { part: "sectionInstructions", section: section.title };
      out.push(
        ...richParagraphs(
          ctx,
          section.instructionsMd,
          () => ({ keepNext: true, spacing: { before: 0, after: 60 } }),
          { italics: true },
        ),
      );
    }
    for (const item of section.items) out.push(...itemBlocks(ctx, item, kind));
  }
  return out;
}

/** The document as .docx bytes, with the formulas that fell back to text and an omitted logo. */
export async function renderDocxDocument(
  doc: ExportDocument,
  kind: DocumentKind,
  options: RenderOptions,
): Promise<{ bytes: Uint8Array; warnings: DocxWarning[] }> {
  const page = PAGE_TWIPS[options.paper];
  const ctx: Ctx = {
    font: FONT_NAMES[options.font],
    contentWidth: page.width - MARGIN.left - MARGIN.right,
    warnings: [],
    where: { part: "instructions" },
  };
  let file: Document;
  try {
    file = buildFile(ctx, doc, kind, page);
  } catch (error) {
    throw error instanceof RenderDocxError
      ? error
      : new RenderDocxError("render", { cause: error });
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await Packer.toBuffer(file));
  } catch (error) {
    throw new RenderDocxError("pack", { cause: error });
  }
  await assertDocxWellFormed(bytes);
  return { bytes, warnings: ctx.warnings };
}

function buildFile(
  ctx: Ctx,
  doc: ExportDocument,
  kind: DocumentKind,
  page: { width: number; height: number },
): Document {
  const children = body(ctx, doc, kind);
  return new Document({
    title: xmlSafe(`${TITLES[kind]} - ${doc.meta.title}`),
    creator: "MitraMatika",
    lastModifiedBy: "MitraMatika",
    styles: { default: { document: { run: { font: ctx.font, size: 24 } } } },
    sections: [
      {
        properties: { page: { size: page, margin: MARGIN } },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    font: ctx.font,
                    size: 20,
                    children: [
                      "Halaman ",
                      PageNumber.CURRENT,
                      " dari ",
                      PageNumber.TOTAL_PAGES,
                    ],
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
}

/** The document as .docx bytes (warnings dropped; the export job uses renderDocxDocument). */
export async function renderDocx(
  doc: ExportDocument,
  kind: DocumentKind,
  options: RenderOptions,
): Promise<Uint8Array> {
  return (await renderDocxDocument(doc, kind, options)).bytes;
}
