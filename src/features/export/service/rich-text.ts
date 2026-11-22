// Question text (Markdown plus $...$ / $$...$$ LaTeX) to safe HTML, at build time. It reuses the
// pieces the web app's MathText uses (splitMath, the decimal comma rewrite, the same KaTeX
// options and the unit-exponent rule), so the paper shows what the screen showed.
//
// Safety: every character of user text is escaped; the only HTML that is not escaped is KaTeX's
// own output (trust: false) and the few tags this file writes itself (p, br, strong, em, sup).
// The subset is deliberate: paragraphs (blank line), line breaks, **bold**, *italic*, math.
// Lists and tables in a stem are shown as plain escaped text.
import katex from "katex";
import { withDecimalComma } from "@/components/math/decimal-comma";
import { splitMath } from "@/components/math/split-math";
import { cutText, xmlSafe } from "./xml";

/**
 * Where a piece of text sits in the document, as data: the app translates it (the document itself
 * is Indonesian, the UI around it is not).
 */
export type WarningWhere =
  | { part: "stem" | "instructions"; number?: number }
  | { part: "option"; number: number; label: string }
  | { part: "step"; number: number; step: number }
  | { part: "sectionInstructions"; section: string };

export interface RenderWarning {
  /**
   * mathFailed: KaTeX refused the formula (it prints as text). mathTooWide: a display formula is
   * wider than the column even at the smallest fit size, so it may run past the printed edge.
   */
  code: "mathFailed" | "mathTooWide";
  where: WarningWhere;
  /** The LaTeX source (cut to 120 characters). */
  source: string;
}

export interface RichContext {
  warnings: RenderWarning[];
  /** Set by the caller before each piece of text. */
  where: WarningWhere;
  /** At least one math span was rendered: the document needs the KaTeX stylesheet. */
  usedMath: boolean;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ESCAPES[char]);

// KaTeX writes the SVG namespace URL into its inline <svg> (square roots, arrows). HTML needs no
// xmlns, and the exported file must contain no URL at all.
const SVG_NAMESPACE = ' xmlns="http://www.w3.org/2000/svg"';

/**
 * The KaTeX options every export renderer validates with (HTML, and the PDF formula boxes), so the
 * set of formulas that fail is the same. `displayMode` and `output` are the caller's.
 */
export const KATEX_EXPORT_OPTIONS = {
  throwOnError: true,
  trust: false,
  strict: "ignore",
  maxSize: 10,
  maxExpand: 100,
} as const;

function renderMath(source: string, display: boolean, ctx: RichContext): string {
  try {
    const html = katex.renderToString(withDecimalComma(source), {
      ...KATEX_EXPORT_OPTIONS,
      displayMode: display,
      // `html` only: the MathML twin carries an xmlns URL and doubles the size. A printed
      // document does not need it.
      output: "html",
    });
    ctx.usedMath = true;
    // KaTeX marks its own output aria-hidden; the wrapper gives screen readers the LaTeX source.
    return `<span class="math" role="img" aria-label="${escapeHtml(source)}">${html.replaceAll(SVG_NAMESPACE, "")}</span>`;
  } catch {
    ctx.warnings.push({
      code: "mathFailed",
      where: ctx.where,
      source: cutText(xmlSafe(source), 120),
    });
    const delimiter = display ? "$$" : "$";
    return `<span class="math-fallback">${escapeHtml(`${delimiter}${source}${delimiter}`)}</span>`;
  }
}

// B-005 (same rule as MathText): `24 cm^2` outside math reads as a superscript. Also used by the
// DOCX renderer.
export const UNIT_EXPONENT =
  /(?<![\p{L}\\])([\p{L}]{1,4}|\d+)\^(-?\d{1,2})(?![\p{L}\p{N}])/gu;

// Wide display formulas (I7). KaTeX sets a display formula on one line that never breaks, and
// print must not clip it. Its width is estimated from what KaTeX rendered: every visible glyph
// counts 1 unit, a binary operator or relation 2 (its glyph and the spaces around it); a sub- or
// superscript counts in full, so the estimate errs wide. FIT_UNITS is what the narrowest column
// (A4, 12 pt, after the item number) holds at full size; a wider formula is set at the largest
// FIT_SIZES step that fits, and one still too wide at the smallest gets a mathTooWide warning
// (the print CSS lets it overflow visibly rather than cut it). DOCX is not affected: Word wraps
// equations itself.
export const FIT_UNITS = 56;
export const FIT_SIZES = [90, 80, 70] as const;
const OPERATORS = new Set(
  "+\u2212-=<>\u2264\u2265\u2260\u00d7\u00f7\u00b1\u2213\u2192\u21d2\u21d4\u2248\u223c\u2261\u2208\u2209\u2282\u2286\u222a\u2229\u22c5",
);

/** The estimated width of KaTeX output, in units (see above). */
export function mathWidthUnits(katexHtml: string): number {
  const text = katexHtml
    .replace(/<[^>]*>/g, "")
    .replace(/&[#a-z0-9]+;/gi, "x")
    .replace(/[\s\u200b]/g, "");
  let units = 0;
  for (const char of text) units += OPERATORS.has(char) ? 2 : 1;
  return units;
}

/** The fit class of a display formula of `units`, and whether it is too wide even so. */
export function displayFit(units: number): { size: number | null; tooWide: boolean } {
  if (units <= FIT_UNITS) return { size: null, tooWide: false };
  const fitting = FIT_SIZES.find((size) => units * (size / 100) <= FIT_UNITS);
  return fitting === undefined
    ? { size: FIT_SIZES[FIT_SIZES.length - 1], tooWide: true }
    : { size: fitting, tooWide: false };
}

/** Escaped text to inline HTML: unit exponents, bold, italic and line breaks. */
export function inlineText(raw: string): string {
  return escapeHtml(raw)
    .replace(UNIT_EXPONENT, "$1<sup>$2</sup>")
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, "<em>$1</em>")
    .replace(/\n/g, "<br>");
}

/**
 * Markdown/LaTeX text to HTML blocks. With `inline` the result has no <p> wrappers (an option's
 * text): paragraphs are joined with a line break and a display formula stays inline.
 */
export function renderRich(md: string, ctx: RichContext, inline = false): string {
  const blocks: string[] = [];
  let paragraph = "";
  const flush = () => {
    const text = paragraph.replace(/^(?:<br>)+|(?:<br>)+$/g, "");
    if (text.trim() !== "") blocks.push(inline ? text : `<p>${text}</p>`);
    paragraph = "";
  };
  for (const segment of splitMath(md.replace(/\r\n?/g, "\n").trim())) {
    if (segment.kind === "text") {
      segment.value.split(/\n{2,}/).forEach((part, index) => {
        if (index > 0) flush();
        paragraph += inlineText(part);
      });
    } else if (segment.kind === "inline" || inline) {
      paragraph += renderMath(segment.value, false, ctx);
    } else {
      flush();
      const failedBefore = ctx.warnings.length;
      const html = renderMath(segment.value, true, ctx);
      // A formula that fell back to text wraps like text: only rendered math is fitted.
      const fit =
        ctx.warnings.length === failedBefore
          ? displayFit(mathWidthUnits(html))
          : { size: null, tooWide: false };
      if (fit.tooWide) {
        ctx.warnings.push({
          code: "mathTooWide",
          where: ctx.where,
          source: cutText(xmlSafe(segment.value), 120),
        });
      }
      const cls = fit.size === null ? "math-block" : `math-block fit-${String(fit.size)}`;
      blocks.push(`<div class="${cls}">${html}</div>`);
    }
  }
  flush();
  return blocks.join(inline ? "<br>" : "");
}
