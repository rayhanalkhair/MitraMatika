// LaTeX to a vector box the PDF can draw (plan decision 4, route B of the React-PDF spike).
//
// KaTeX validates first with the options every export renderer shares, so the set of formulas
// that fail is the same as in the preview and in Word; it then writes MathML, which MathJax
// typesets to SVG with `fontCache: "none"` (every glyph is a `<path>`, no font is needed for
// maths). The lite DOM is walked into plain data through an allowlist: any other element makes
// the formula a failure (the caller prints `$source$`), never an unknown element in the PDF.
//
// Spike findings applied here (docs/research/react-pdf-spike-findings.md, S2): the attribute
// allowlist includes x1 y1 x2 y2 (`\cancel`); React-PDF has no nested Svg, so a nested <svg>
// becomes a <g> with the transform that maps its viewBox onto its box; `stroke-width="0"` (MathJax
// says "no stroke") would be drawn as a hairline, so it is removed, and an element with its own
// stroke width gets an explicit black stroke.
import katex from "katex";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { MathML } from "mathjax-full/js/input/mathml.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import "server-only";
import { withDecimalComma } from "@/components/math/decimal-comma";
import { KATEX_EXPORT_OPTIONS } from "../rich-text";

// Validation uses KATEX_EXPORT_OPTIONS (strict "ignore"), the same object the HTML preview renders
// with, so a formula the preview shows is not refused for a strictness warning. DOCX validates
// with strict "error" in latex-to-omml.ts, so a few formulas fail in Word that PDF and preview
// accept; the options are shared with the preview on purpose, not with Word.

export interface SvgNode {
  tag: "svg" | "g" | "path" | "rect" | "line" | "text";
  attrs: Record<string, string>;
  children: SvgNode[];
  text?: string;
}

/** A typeset formula. 1 em is the font size; `depthEm` is the part below the baseline. */
export interface MathBox {
  viewBox: [number, number, number, number];
  widthEm: number;
  heightEm: number;
  depthEm: number;
  nodes: SvgNode[];
}

export type MathBoxErrorCode = "parse" | "unsupported" | "limit";

/** The message is fixed on purpose: it never carries the (user's) source. */
export class MathBoxError extends Error {
  readonly code: MathBoxErrorCode;
  constructor(code: MathBoxErrorCode, options?: { cause?: unknown }) {
    super(`math: ${code}`, options);
    this.name = "MathBoxError";
    this.code = code;
  }
}

/** Longest formula source accepted (the PDF caps the document's total separately). */
const MAX_SOURCE_LENGTH = 2000;
/** Most SVG nodes one formula may produce. */
const MAX_NODES = 20_000;

// `text` is deliberately not on the list. MathJax emits <text> for glyphs outside its own font
// (for example `\text{中文}` or an emoji) even with fontCache "none"; the spike corpus never hit
// it. Such a formula fails in the PDF only (`unsupported`, printed as the source between dollar
// signs with a `mathFailed` warning) while the preview and Word still show it: a known
// preview/PDF parity gap.
const ALLOWED_TAGS = new Set(["svg", "g", "path", "rect", "line"]);
const ALLOWED_ATTRS = new Set([
  "d",
  "transform",
  "x",
  "y",
  "width",
  "height",
  "viewBox",
  "fill",
  "stroke",
  "stroke-width",
  "x1",
  "y1",
  "x2",
  "y2",
]);

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ANNOTATION = /<annotation\b[^>]*>[\s\S]*?<\/annotation>/g;

export interface LiteAdaptorLike {
  kind(node: unknown): string;
  allAttributes(node: unknown): { name: string; value: string }[];
  childNodes(node: unknown): unknown[];
  textContent(node: unknown): string;
}
interface MathConverter {
  convert(math: string, options: { display: boolean }): unknown;
}

let converter: { adaptor: LiteAdaptorLike; document: MathConverter } | undefined;

/** One MathJax document for the whole process, created on first use. */
function mathjaxConverter(): NonNullable<typeof converter> {
  if (converter === undefined) {
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    const document = mathjax.document("", {
      InputJax: new MathML(),
      OutputJax: new SVG({ fontCache: "none" }),
    });
    converter = {
      adaptor: adaptor as unknown as LiteAdaptorLike,
      document: document as unknown as MathConverter,
    };
  }
  return converter;
}

/** KaTeX validation (the preview's failures, plus refused trust requests); returns its MathML. */
function katexMathMl(source: string, display: boolean): string {
  const refused: string[] = [];
  let rendered: string;
  try {
    rendered = katex.renderToString(withDecimalComma(source), {
      ...KATEX_EXPORT_OPTIONS,
      output: "mathml",
      displayMode: display,
      // With trust off KaTeX does not throw on \href, \includegraphics and the like: it prints
      // the command in red. Refusing every request turns those into failures here instead.
      trust: (context) => {
        refused.push(context.command);
        return false;
      },
    });
  } catch (cause) {
    throw new MathBoxError("parse", { cause });
  }
  if (refused.length > 0) throw new MathBoxError("unsupported");
  const math = /<math[\s>][\s\S]*<\/math>/.exec(rendered)?.[0];
  if (math === undefined) throw new MathBoxError("parse");
  return math.replace(ANNOTATION, "");
}

/** An attribute that may be absent (the project's index signatures do not say so). */
const attr = (attrs: Record<string, string>, name: string): string | undefined =>
  (attrs as Partial<Record<string, string>>)[name];

const trimNumber = (value: number): string => String(Number(value.toFixed(5)));

/** A nested <svg> as a <g>: its viewBox mapped onto its x, y, width, height (meet, centred). */
function nestedSvgTransform(attrs: Record<string, string>): string {
  const [vx = 0, vy = 0, vw = 1, vh = 1] = (attr(attrs, "viewBox") ?? "")
    .split(/\s+/)
    .map(Number);
  const x = Number(attr(attrs, "x") ?? 0);
  const y = Number(attr(attrs, "y") ?? 0);
  const width = Number(attr(attrs, "width") ?? vw);
  const height = Number(attr(attrs, "height") ?? vh);
  const scale = Math.min(width / vw, height / vh);
  const tx = x + (width - vw * scale) / 2 - vx * scale;
  const ty = y + (height - vh * scale) / 2 - vy * scale;
  if (![scale, tx, ty].every(Number.isFinite)) throw new MathBoxError("parse");
  // React-PDF's transform parser needs commas.
  return `translate(${trimNumber(tx)},${trimNumber(ty)}) scale(${trimNumber(scale)})`;
}

function walk(
  node: unknown,
  adaptor: LiteAdaptorLike,
  budget: { nodes: number },
): SvgNode | null {
  const tag = adaptor.kind(node);
  if (tag === "#text" || tag === "#comment") return null;
  if (!ALLOWED_TAGS.has(tag)) throw new MathBoxError("unsupported");
  if (++budget.nodes > MAX_NODES) throw new MathBoxError("limit");
  const attrs: Record<string, string> = {};
  for (const { name, value } of adaptor.allAttributes(node)) {
    if (name === "data-mml-node" && value === "merror") throw new MathBoxError("parse");
    if (!ALLOWED_ATTRS.has(name)) continue;
    if (/https?:/i.test(value)) throw new MathBoxError("unsupported");
    attrs[name] = value === "currentColor" ? "#000000" : value;
  }
  if (attr(attrs, "stroke-width") === "0") {
    delete attrs.stroke;
    delete attrs["stroke-width"];
  } else if (
    attr(attrs, "stroke-width") !== undefined &&
    attr(attrs, "stroke") === undefined
  ) {
    // An enclosure (box, strike) strokes in the colour the root group set (currentColor).
    attrs.stroke = "#000000";
  }
  const children: SvgNode[] = [];
  for (const child of adaptor.childNodes(node)) {
    const converted = walk(child, adaptor, budget);
    if (converted !== null) children.push(converted);
  }
  return { tag: tag as SvgNode["tag"], attrs, children };
}

/** The same tree with every nested svg (the root's children only) replaced by a group. */
function flattenNested(nodes: SvgNode[]): SvgNode[] {
  return nodes.map((node) => {
    const children = flattenNested(node.children);
    if (node.tag !== "svg") return { ...node, children };
    return { tag: "g", attrs: { transform: nestedSvgTransform(node.attrs) }, children };
  });
}

/**
 * The box of MathJax's output container. Exported for tests (a fake adaptor reaches the branches
 * real MathJax output does not). Only a `MathBoxError` leaves: a RangeError from very deep nesting
 * is a `limit`, anything else unexpected a `parse`.
 */
export function boxFromContainer(container: unknown, adaptor: LiteAdaptorLike): MathBox {
  try {
    return buildBox(container, adaptor);
  } catch (error) {
    if (error instanceof MathBoxError) throw error;
    throw new MathBoxError(error instanceof RangeError ? "limit" : "parse", {
      cause: error,
    });
  }
}

function buildBox(container: unknown, adaptor: LiteAdaptorLike): MathBox {
  const svg = adaptor.childNodes(container).find((node) => adaptor.kind(node) === "svg");
  if (svg === undefined) throw new MathBoxError("parse");
  const root = walk(svg, adaptor, { nodes: 0 });
  const viewBox = (root === null ? undefined : attr(root.attrs, "viewBox"))
    ?.split(/\s+/)
    .map(Number);
  if (root === null || viewBox?.length !== 4 || !viewBox.every(Number.isFinite)) {
    throw new MathBoxError("parse");
  }
  const [x, y, width, height] = viewBox as [number, number, number, number];
  if (width <= 0 || height <= 0) throw new MathBoxError("parse");
  return {
    viewBox: [x, y, width, height],
    widthEm: width / 1000,
    heightEm: -y / 1000,
    depthEm: (y + height) / 1000,
    nodes: flattenNested(root.children),
  };
}

/** MathML to a frozen box: the part of the pipeline LaTeX and a lone glyph share. */
function typesetMathMl(mathMl: string, display: boolean): MathBox {
  const { adaptor, document } = mathjaxConverter();
  let container: unknown;
  try {
    container = document.convert(mathMl, { display });
  } catch (cause) {
    throw new MathBoxError("parse", { cause });
  }
  return deepFreeze(boxFromContainer(container, adaptor));
}

/**
 * Typeset one formula. Throws `MathBoxError` (fixed message, the original error only as `cause`)
 * for anything KaTeX refuses, MathJax cannot draw, or that is out of bounds.
 */
export function latexToMathBox(source: string, display: boolean): MathBox {
  if (source.trim() === "" || CONTROL_CHARACTERS.test(source))
    throw new MathBoxError("parse");
  if (source.length > MAX_SOURCE_LENGTH) throw new MathBoxError("limit");
  return typesetMathMl(katexMathMl(source, display), display);
}

const glyphBoxes = new Map<string, MathBox>();

/**
 * One arrow or math operator (U+2190..U+22FF) as an inline box with no spacing around it, for
 * prose that needs a symbol no text font has (`∉`, `≠`: KaTeX builds them from other glyphs).
 * Anything else is a `parse` error.
 */
export function glyphToMathBox(glyph: string): MathBox {
  const code = glyph.codePointAt(0);
  if (
    code === undefined ||
    code < 0x2190 ||
    code > 0x22ff ||
    glyph.length !== String.fromCodePoint(code).length ||
    glyph.length > 1
  ) {
    throw new MathBoxError("parse");
  }
  let box = glyphBoxes.get(glyph);
  if (box === undefined) {
    box = typesetMathMl(`<math><mo lspace="0" rspace="0">${glyph}</mo></math>`, false);
    glyphBoxes.set(glyph, box);
  }
  return box;
}

/** A cached box is shared by every place its formula appears: nobody may change it. */
function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
}

/** Typeset formulas of one export, memoised: the paper and the solutions share most of them. */
export type MathCache = (source: string, display: boolean) => MathBox | MathBoxError;

export function createMathCache(): MathCache {
  const results = new Map<string, MathBox | MathBoxError>();
  return (source, display) => {
    const key = `${display ? "d" : "i"}:${source}`;
    let result = results.get(key);
    if (result === undefined) {
      try {
        result = latexToMathBox(source, display);
      } catch (error) {
        if (!(error instanceof MathBoxError)) throw error;
        result = error;
      }
      results.set(key, result);
    }
    return result;
  };
}
