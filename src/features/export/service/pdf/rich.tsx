// Question text as React-PDF elements (plan decisions 5 to 7; spike S3, S8, S4).
//
// React-PDF's Text cannot contain a Svg. A paragraph without a formula is therefore one Text
// (nested Text for the runs that need another font or a superscript). A paragraph with a
// formula, or with a symbol drawn as a glyph box, is a row View that wraps: one Text per word and
// one Svg per formula, the Svg shifted so its baseline sits on the text baseline (spike S3).
//
// These are plain functions run once while the tree is built, not components: `ctx.where` is set
// by the caller before each call, so the warnings carry the right place.
import { G, Line, Path, Rect, Svg, Text, View } from "@react-pdf/renderer";
import type { ReactElement, ReactNode } from "react";
import type { TemplateFont } from "@/features/templates";
import type { RenderWarning } from "../rich-text";
import { parseRich, type RichBlock, type RichRun } from "../rich-blocks";
import { cutText, xmlSafe } from "../xml";
import { breakOverwideWords, estimateWidth } from "./text-width";
import type { PdfContext } from "./context";
import { fitMath } from "./fit";
import {
  MONO_FAMILY,
  pdfFontFamily,
  splitByCoverage,
  type FontStyle,
  type PdfRun,
} from "./fonts";
import { glyphToMathBox, MathBoxError, type MathBox, type SvgNode } from "./math-box";
import {
  BASELINE_EM,
  BODY_PT,
  LINE_HEIGHT,
  PARAGRAPH_GAP,
  SPACE_EM,
  SUP_SCALE,
  type PdfStyle,
  textStyle,
} from "./styles";

export interface RichOptions {
  font: TemplateFont;
  /** The width the text may use, in points: formulas are fitted to it, lines are estimated from it. */
  widthPt: number;
  /** Text size, default 12 pt. */
  fontSize?: number;
  /** The whole text is bold or italic (an answer line, a section's instructions). */
  bold?: boolean;
  italic?: boolean;
  /** An option's or step's text: no gap after the paragraph, a display formula stays inline. */
  inline?: boolean;
}

/** The elements of a piece of text and the height they are estimated to take (see S4). */
export interface Rich {
  nodes: ReactElement[];
  heightPt: number;
  /**
   * How far the baseline of the first line sits below that of a plain text line: a formula taller
   * than a line makes the line taller and, with the items aligned to its bottom, pushes the
   * text down. A label drawn beside the text (option letter, item or step number) takes this as
   * its top margin so both share a baseline (S-02).
   */
  firstLineLiftPt: number;
}

interface Made {
  node: ReactElement;
  heightPt: number;
  firstLineLiftPt?: number;
}

// ---------------------------------------------------------------------------------------------
// Formulas
// ---------------------------------------------------------------------------------------------

/** Attribute names are written with hyphens in SVG, in camelCase in React-PDF. */
const camel = (name: string): string =>
  name.replace(/-(\w)/g, (_match, letter: string) => letter.toUpperCase());

/** An attribute that may be absent: the project's index signatures do not say so. */
const optionalAttr = (node: SvgNode, name: string): string | undefined =>
  (node.attrs as Partial<Record<string, string>>)[name];

function svgProps(node: SvgNode): Record<string, string> {
  const props: Record<string, string> = {};
  for (const [name, value] of Object.entries(node.attrs)) props[camel(name)] = value;
  return props;
}

/** A box's node tree as React-PDF primitives. A node that lacks what its primitive needs is left out. */
function svgTree(node: SvgNode, key: number): ReactElement | null {
  const props = svgProps(node);
  switch (node.tag) {
    case "g":
    case "svg": // nested svg is turned into a group by math-box; a stray one is just a group
      return (
        <G key={key} {...props}>
          {node.children.map((child, index) => svgTree(child, index))}
        </G>
      );
    case "path":
      if (optionalAttr(node, "d") === undefined) return null;
      return <Path key={key} {...props} d={optionalAttr(node, "d") ?? ""} />;
    case "rect":
      if (
        optionalAttr(node, "width") === undefined ||
        optionalAttr(node, "height") === undefined
      )
        return null;
      return (
        <Rect
          key={key}
          {...props}
          width={optionalAttr(node, "width") ?? "0"}
          height={optionalAttr(node, "height") ?? "0"}
        />
      );
    case "line": {
      const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((name) =>
        Number(optionalAttr(node, name)),
      );
      if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
      return <Line key={key} {...props} x1={x1} y1={y1} x2={x2} y2={y2} />;
    }
    case "text": // never produced: math-box's allowlist refuses it
      return null;
  }
}

interface Placed {
  scale: number;
  widthPt: number;
  heightPt: number;
  /** Distance the Svg hangs below the baseline, in points. */
  depthPt: number;
}

function place(box: MathBox, fontSize: number, scale: number): Placed {
  return {
    scale,
    widthPt: box.widthEm * fontSize * scale,
    heightPt: (box.heightEm + box.depthEm) * fontSize * scale,
    depthPt: box.depthEm * fontSize * scale,
  };
}

/** One formula as an Svg of its own size; `marginBottom` lifts it onto the text baseline. */
function formulaSvg(
  box: MathBox,
  placed: Placed,
  marginBottom: number,
  key: number | string,
): ReactElement {
  const [x, y, width, height] = box.viewBox;
  return (
    <Svg
      key={key}
      viewBox={`${String(x)} ${String(y)} ${String(width)} ${String(height)}`}
      width={placed.widthPt}
      height={placed.heightPt}
      style={{ marginBottom }}
    >
      {box.nodes.map((node, index) => svgTree(node, index))}
    </Svg>
  );
}

const warn = (ctx: PdfContext, code: RenderWarning["code"], source: string): void => {
  ctx.warnings.push({ code, where: ctx.where, source: cutText(xmlSafe(source), 120) });
};

/**
 * The scale a formula is drawn at (R31: 100, 90, 80 or 70 %). Even at 70 % too wide it warns
 * (`mathTooWide`) and is shrunk further until it fits the column, however small, so that a
 * formula never runs past the right margin (an illegible one is what the warning is for).
 */
function fitted(
  box: MathBox,
  fontSize: number,
  widthPt: number,
  source: string,
  ctx: PdfContext,
): Placed {
  const natural = box.widthEm * fontSize;
  const fit = fitMath(natural, widthPt);
  if (!fit.tooWide) return place(box, fontSize, fit.scale);
  warn(ctx, "mathTooWide", source);
  return place(box, fontSize, Math.min(fit.scale, widthPt / natural));
}

// ---------------------------------------------------------------------------------------------
// Characters to chunks: text in one font, formulas and symbol boxes
// ---------------------------------------------------------------------------------------------

interface Chunk {
  text: string;
  family: string;
  sup: boolean;
}

type Atom =
  | { kind: "chunk"; chunk: Chunk }
  | { kind: "formula"; box: MathBox; source: string }
  | { kind: "glyph"; box: MathBox }
  | { kind: "break" };

/** The column text is set in: a word estimated wider than it is cut (see text-width.ts). */
interface Fit {
  fontSize: number;
  widthPt: number;
}

/** Prose in `font` as chunks (and glyph boxes for the symbols no font has). */
function proseAtoms(
  text: string,
  font: TemplateFont,
  style: FontStyle,
  sup: boolean,
  fit: Fit,
  mono = false,
): Atom[] {
  const base = pdfFontFamily(font, style);
  const atoms: Atom[] = [];
  for (const run of splitByCoverage(text, font, style)) {
    atoms.push(...runAtoms(run, base, sup, mono, fit));
  }
  return atoms;
}

/** Text Courier (WinAnsi) can draw: printable ASCII, Latin-1 and a newline. */
const WIN_ANSI_ONLY = /^[\n\x20-\x7e\xa0-\xff]*$/;

function runAtoms(
  run: PdfRun,
  base: string,
  sup: boolean,
  mono: boolean,
  fit: Fit,
): Atom[] {
  if (run.kind === "text") {
    // Courier is a base-14 face (WinAnsi only, not embedded): the `$source$` fallback uses it for
    // runs made only of WinAnsi characters and keeps the embedded face for the rest (Greek,
    // ≤ ≥ ≠ → ∞ √ ±), which Courier would print blank or wrong.
    const family =
      mono && run.family === base && WIN_ANSI_ONLY.test(run.text)
        ? MONO_FAMILY
        : run.family;
    const size = sup ? fit.fontSize * SUP_SCALE : fit.fontSize;
    const atoms: Atom[] = [];
    breakOverwideWords(run.text, family, size, fit.widthPt).forEach((text, index) => {
      if (index > 0) atoms.push({ kind: "break" });
      atoms.push({ kind: "chunk", chunk: { text, family, sup } });
    });
    return atoms;
  }
  if (mono) return [];
  try {
    return [{ kind: "glyph", box: glyphToMathBox(run.text) }];
  } catch (error) {
    if (error instanceof MathBoxError) return []; // the symbol is left out, never a throw
    throw error;
  }
}

function runsToAtoms(
  runs: RichRun[],
  opts: RichOptions,
  ctx: PdfContext,
  display: boolean,
): Atom[] {
  const atoms: Atom[] = [];
  const fit = { fontSize: opts.fontSize ?? BODY_PT, widthPt: opts.widthPt };
  for (const run of runs) {
    if (run.kind === "break") {
      atoms.push({ kind: "break" });
    } else if (run.kind === "text") {
      atoms.push(
        ...proseAtoms(
          run.text,
          opts.font,
          {
            bold: opts.bold === true || run.bold,
            italic: opts.italic === true || run.italic,
          },
          run.sup,
          fit,
        ),
      );
    } else {
      const result = ctx.math(run.source, display);
      if (result instanceof MathBoxError) {
        warn(ctx, "mathFailed", run.source);
        const delimiter = display ? "$$" : "$";
        atoms.push(
          ...proseAtoms(
            `${delimiter}${run.source}${delimiter}`,
            opts.font,
            {},
            false,
            fit,
            true,
          ),
        );
      } else {
        atoms.push({ kind: "formula", box: result, source: run.source });
      }
    }
  }
  return atoms;
}

// ---------------------------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------------------------

/** What a Text holds for a chunk: a bare string when the Text's own font draws it, else a nested Text. */
function chunkChild(
  chunk: Chunk,
  ownFamily: string,
  fontSize: number,
  key: number,
): ReactNode {
  if (chunk.family === ownFamily && !chunk.sup) return chunk.text;
  return (
    <Text
      key={key}
      style={textStyle(
        chunk.family,
        chunk.sup ? fontSize * SUP_SCALE : fontSize,
        chunk.sup ? { verticalAlign: "super" } : {},
      )}
    >
      {chunk.text}
    </Text>
  );
}

/**
 * Rough line count of a paragraph (spike S4's estimator): 0.55 em per character plus the width of
 * the formulas, wrapped at `widthPt`, one segment per forced break. It runs 16 to 25 % high on
 * prose, which errs toward letting a borderline item split rather than losing text.
 */
class LineEstimate {
  private lines = 0;
  private chars = 0;
  private extraWidth = 0;
  constructor(
    private readonly fontSize: number,
    private readonly widthPt: number,
  ) {}
  addChars(count: number): void {
    this.chars += count;
  }
  addWidth(widthPt: number): void {
    this.extraWidth += widthPt;
  }
  /** A forced break ends the segment. */
  endSegment(): void {
    const width = this.chars * 0.55 * this.fontSize + this.extraWidth;
    this.lines += Math.max(1, Math.ceil(width / this.widthPt));
    this.chars = 0;
    this.extraWidth = 0;
  }
  total(): number {
    this.endSegment();
    return this.lines;
  }
}

/** A paragraph with no formula: one Text. */
function plainParagraph(
  atoms: Atom[],
  opts: RichOptions,
  gap: number,
  key: number,
): Made {
  const fontSize = opts.fontSize ?? BODY_PT;
  const family = pdfFontFamily(opts.font, { bold: opts.bold, italic: opts.italic });
  const children: ReactNode[] = [];
  const estimate = new LineEstimate(fontSize, opts.widthPt);
  atoms.forEach((atom, index) => {
    if (atom.kind === "break") {
      children.push("\n");
      estimate.endSegment();
    } else if (atom.kind === "chunk") {
      estimate.addChars(Array.from(atom.chunk.text).length);
      children.push(chunkChild(atom.chunk, family, fontSize, index));
    }
  });
  const lines = estimate.total();
  return {
    node: (
      <Text key={key} style={textStyle(family, fontSize, { marginBottom: gap })}>
        {children}
      </Text>
    ),
    heightPt: lines * fontSize * LINE_HEIGHT + gap,
  };
}

type Piece =
  | { kind: "word"; chunks: Chunk[]; gap: boolean }
  | { kind: "box"; box: MathBox; source: string | null; gap: boolean }
  | { kind: "break" };

/** Atoms to words and boxes: whitespace ends a word and sets the gap after the piece before it. */
function toPieces(atoms: Atom[]): Piece[] {
  const pieces: Piece[] = [];
  let word: Chunk[] = [];
  const endWord = (gap: boolean) => {
    if (word.length > 0) pieces.push({ kind: "word", chunks: word, gap });
    word = [];
  };
  const markGap = () => {
    const last = pieces.at(-1);
    if (last !== undefined && last.kind !== "break") last.gap = true;
  };
  for (const atom of atoms) {
    if (atom.kind === "break") {
      endWord(false);
      pieces.push({ kind: "break" });
    } else if (atom.kind === "formula" || atom.kind === "glyph") {
      endWord(false);
      pieces.push({
        kind: "box",
        box: atom.box,
        source: atom.kind === "formula" ? atom.source : null,
        gap: false,
      });
    } else {
      // Split the chunk at whitespace: words stay in `word`, a space ends it.
      for (const part of atom.chunk.text.split(/(\s+)/)) {
        if (part === "") continue;
        if (/^\s+$/.test(part)) {
          if (word.length > 0) endWord(true);
          else markGap();
        } else {
          word.push({ ...atom.chunk, text: part });
        }
      }
    }
  }
  endWord(false);
  return pieces;
}

/** A paragraph with formulas: a wrapping row of words and Svg boxes. */
function rowParagraph(
  atoms: Atom[],
  opts: RichOptions,
  ctx: PdfContext,
  gap: number,
  key: number,
): Made {
  const fontSize = opts.fontSize ?? BODY_PT;
  const space = SPACE_EM[opts.font] * fontSize;
  const lineHeight = fontSize * LINE_HEIGHT;
  const items: ReactElement[] = [];
  const estimate = new LineEstimate(fontSize, opts.widthPt);
  let taller = 0;
  let afterBreak = false;
  // The first line, as the flex wrap will fill it: pieces until one does not fit or a break.
  let lineOpen = true;
  let lineUsed = 0;
  let lineTallest = lineHeight;
  const joinFirstLine = (widthPt: number, outerPt: number, gapPt: number): void => {
    if (!lineOpen) return;
    if (lineUsed > 0 && lineUsed + widthPt > opts.widthPt) {
      lineOpen = false;
      return;
    }
    lineUsed += widthPt + gapPt;
    lineTallest = Math.max(lineTallest, outerPt);
  };
  toPieces(atoms).forEach((piece, index) => {
    if (piece.kind === "break") {
      if (lineUsed > 0) lineOpen = false;
      // A zero-height full-width item forces the next piece onto a new line; a second one in a
      // row is a blank line.
      items.push(
        <View
          key={index}
          style={{ width: "100%", height: afterBreak ? lineHeight : 0 }}
        />,
      );
      estimate.endSegment();
      afterBreak = true;
      return;
    }
    afterBreak = false;
    if (piece.kind === "word") {
      const first = piece.chunks[0];
      const family = first.family;
      estimate.addChars(
        piece.chunks.reduce((sum, chunk) => sum + Array.from(chunk.text).length, 0),
      );
      joinFirstLine(
        piece.chunks.reduce(
          (sum, chunk) =>
            sum +
            estimateWidth(
              chunk.text,
              chunk.family,
              chunk.sup ? fontSize * SUP_SCALE : fontSize,
            ),
          0,
        ),
        lineHeight,
        piece.gap ? space : 0,
      );
      items.push(
        <Text
          key={index}
          style={textStyle(family, fontSize, { marginRight: piece.gap ? space : 0 })}
        >
          {piece.chunks.map((chunk, at) => chunkChild(chunk, family, fontSize, at))}
        </Text>,
      );
      return;
    }
    const placed = fitted(piece.box, fontSize, opts.widthPt, piece.source ?? "", ctx);
    estimate.addWidth(placed.widthPt + (piece.gap ? space : 0));
    taller += Math.max(0, placed.heightPt - lineHeight);
    const lift = BASELINE_EM * fontSize - placed.depthPt;
    joinFirstLine(placed.widthPt, placed.heightPt + lift, piece.gap ? space : 0);
    items.push(formulaSvg(piece.box, placed, lift, index));
    if (piece.gap) {
      items.push(<View key={`${String(index)}g`} style={{ width: space, height: 0 }} />);
    }
  });
  const lines = estimate.total();
  return {
    node: (
      <View
        key={key}
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginBottom: gap,
        }}
      >
        {items}
      </View>
    ),
    heightPt: lines * lineHeight + taller + gap,
    firstLineLiftPt: Math.max(0, lineTallest - lineHeight),
  };
}

function paragraph(
  runs: RichRun[],
  opts: RichOptions,
  ctx: PdfContext,
  key: number,
): Made {
  const gap = opts.inline === true ? 0 : PARAGRAPH_GAP;
  const atoms = runsToAtoms(runs, opts, ctx, false);
  const needsRow = atoms.some((atom) => atom.kind === "formula" || atom.kind === "glyph");
  return needsRow
    ? rowParagraph(atoms, opts, ctx, gap, key)
    : plainParagraph(atoms, opts, gap, key);
}

/** A display formula: centred on its own line; a failed one is its source in Courier. */
function displayFormula(
  source: string,
  opts: RichOptions,
  ctx: PdfContext,
  key: number,
): Made {
  const fontSize = opts.fontSize ?? BODY_PT;
  const result = ctx.math(source, true);
  if (result instanceof MathBoxError) {
    warn(ctx, "mathFailed", source);
    return plainParagraph(
      proseAtoms(
        `$$${source}$$`,
        opts.font,
        {},
        false,
        { fontSize, widthPt: opts.widthPt },
        true,
      ),
      opts,
      PARAGRAPH_GAP,
      key,
    );
  }
  const placed = fitted(result, fontSize, opts.widthPt, source, ctx);
  return {
    node: (
      <View key={key} style={{ alignItems: "center", marginVertical: PARAGRAPH_GAP }}>
        {formulaSvg(result, placed, 0, 0)}
      </View>
    ),
    heightPt: placed.heightPt + 2 * PARAGRAPH_GAP,
  };
}

/** Parsed blocks as elements, in order, with the estimated height of all of them. */
export function richBlocks(
  blocks: RichBlock[],
  ctx: PdfContext,
  opts: RichOptions,
): Rich {
  const nodes: ReactElement[] = [];
  let heightPt = 0;
  let firstLineLiftPt = 0;
  blocks.forEach((block, index) => {
    const made =
      block.kind === "display"
        ? displayFormula(block.source, opts, ctx, index)
        : paragraph(block.runs, opts, ctx, index);
    nodes.push(made.node);
    heightPt += made.heightPt;
    if (index === 0) firstLineLiftPt = made.firstLineLiftPt ?? 0;
  });
  return { nodes, heightPt, firstLineLiftPt };
}

/** Markdown/LaTeX text as elements (the subset of `renderRich`; the same parsing). */
export function richText(md: string, ctx: PdfContext, opts: RichOptions): Rich {
  return richBlocks(parseRich(md, opts.inline === true), ctx, opts);
}

/**
 * A line of plain user text (a school name, a title): every character goes through the font
 * coverage split, so control characters and symbols no font has can never reach the PDF as
 * garbage. Not parsed as Markdown.
 */
export function plainText(
  text: string,
  font: TemplateFont,
  options: {
    fontSize?: number;
    bold?: boolean;
    italic?: boolean;
    lineHeight?: number;
    style?: PdfStyle;
    minPresenceAhead?: number;
    key?: string | number;
  } = {},
): ReactElement {
  const fontSize = options.fontSize ?? BODY_PT;
  const family = pdfFontFamily(font, { bold: options.bold, italic: options.italic });
  const children: ReactNode[] = [];
  splitByCoverage(text, font, { bold: options.bold, italic: options.italic }).forEach(
    (run, index) => {
      if (run.kind !== "text") return;
      children.push(
        chunkChild(
          { text: run.text, family: run.family, sup: false },
          family,
          fontSize,
          index,
        ),
      );
    },
  );
  return (
    <Text
      key={options.key}
      {...(options.minPresenceAhead === undefined
        ? {}
        : { minPresenceAhead: options.minPresenceAhead })}
      style={textStyle(family, fontSize, {
        ...(options.lineHeight === undefined ? {} : { lineHeight: options.lineHeight }),
        ...options.style,
      })}
    >
      {children}
    </Text>
  );
}
