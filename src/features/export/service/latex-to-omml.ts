// LaTeX to a native Word equation (OMML), ADR-0013: KaTeX writes MathML, `mathml2omml` turns it
// into an <m:oMath> element. Anything either side cannot handle throws a LatexToOmmlError; the
// DOCX renderer then prints the LaTeX source as plain text and records a warning.
//
// KaTeX runs strict (trust off, strict "error", the same size and expansion limits as the HTML
// renderer). The MathML is checked against the elements mathml2omml converts before it is
// handed over: an unknown element would otherwise be dropped with a console warning and the
// equation would silently lose content (\phantom, for example).
import katex from "katex";
import { mml2omml } from "mathml2omml";
import {
  childElements,
  descendants,
  NOT_XML_CHAR,
  parseXml,
  serializeXml,
  textOf,
  type XmlNode,
} from "./xml";

export type LatexToOmmlErrorCode = "parse" | "unsupported" | "conversion";

/** A formula Word cannot get as an equation. The message never contains the LaTeX source. */
export class LatexToOmmlError extends Error {
  constructor(
    readonly code: LatexToOmmlErrorCode,
    options?: { cause?: unknown },
  ) {
    super(`latexToOmml: ${code}`, options);
    this.name = "LatexToOmmlError";
  }
}

// The MathML elements mathml2omml 0.5.0 converts (its handler table), minus `annotation`, which
// is removed before conversion.
const SUPPORTED = new Set([
  "math",
  "semantics",
  "menclose",
  "mfrac",
  "mglyph",
  "mi",
  "mmultiscripts",
  "mn",
  "mo",
  "mover",
  "mroot",
  "mrow",
  "ms",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
]);

const ANNOTATION = /<annotation\b[^>]*>[\s\S]*?<\/annotation>/g;

function toMathMl(latex: string): string {
  let rendered: string;
  // With trust off KaTeX does not throw on \href, \includegraphics and the like: it prints the
  // command name in red. Refusing every trust request makes those a failure here instead.
  const refused: string[] = [];
  try {
    rendered = katex.renderToString(latex, {
      output: "mathml",
      throwOnError: true,
      trust: (context) => {
        refused.push(context.command);
        return false;
      },
      strict: "error",
      maxSize: 10,
      maxExpand: 100,
    });
  } catch (error) {
    throw new LatexToOmmlError("parse", { cause: error });
  }
  if (refused.length > 0) throw new LatexToOmmlError("unsupported");
  const math = /<math[\s>][\s\S]*<\/math>/.exec(rendered)?.[0];
  if (!math) throw new LatexToOmmlError("conversion");
  return math.replace(ANNOTATION, "");
}

// ---------------------------------------------------------------------------------------------
// Before conversion: rewrite what mathml2omml would get wrong.

// \mathbb: Unicode has letter-like forms for C H N P Q R Z; the rest are in the mathematical
// double-struck block. Word shows the characters as they are, so the style survives.
const DOUBLE_STRUCK_SPECIAL: Record<string, string> = {
  C: "ℂ",
  H: "ℍ",
  N: "ℕ",
  P: "ℙ",
  Q: "ℚ",
  R: "ℝ",
  Z: "ℤ",
};
function doubleStruck(text: string): string {
  return Array.from(text, (char) => {
    if (DOUBLE_STRUCK_SPECIAL[char]) return DOUBLE_STRUCK_SPECIAL[char];
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x41 && code <= 0x5a) return String.fromCodePoint(0x1d538 + code - 0x41);
    if (code >= 0x61 && code <= 0x7a) return String.fromCodePoint(0x1d552 + code - 0x61);
    if (code >= 0x30 && code <= 0x39) return String.fromCodePoint(0x1d7d8 + code - 0x30);
    return char;
  }).join("");
}

const UNDERLINE_MARKS = new Set(["‾", "_", "̲"]);
const TOKENS = new Set(["mi", "mn", "mo", "mtext"]);

/**
 * Rewrites the MathML in place and returns, in document order, whether each mfrac has no bar
 * (\binom: linethickness 0), which mathml2omml ignores.
 */
function prepareMathMl(root: XmlNode): boolean[] {
  const noBar: boolean[] = [];
  for (const node of descendants(root)) {
    if (node.name === "mfrac") {
      const thick = Object.hasOwn(node.attributes, "linethickness");
      noBar.push(thick && Number.parseFloat(node.attributes.linethickness) === 0);
    }
    if (TOKENS.has(node.name) && node.attributes.mathvariant === "double-struck") {
      node.children = node.children.map((c) =>
        typeof c === "string" ? doubleStruck(c) : c,
      );
      node.attributes.mathvariant = "normal";
    }
    // \underline is <munder> with a line mark, which mathml2omml turns into an OVERline accent.
    // An enclosure with only its bottom edge is an underline Word can edit.
    const [base, mark] = childElements(node);
    if (
      node.name === "munder" &&
      childElements(node).length === 2 &&
      mark.name === "mo" &&
      UNDERLINE_MARKS.has(textOf(mark).trim())
    ) {
      node.name = "menclose";
      node.attributes = { notation: "bottom" };
      node.children = [base];
    }
  }
  return noBar;
}

// ---------------------------------------------------------------------------------------------
// After conversion: make mathml2omml 0.5.0's output conform to the OMML schema.

const STYLES = new Set(["p", "b", "i", "bi"]);
// CT_OMathArg: an argument's first child may be one m:argPr.
const ARGUMENTS = new Set([
  "m:e",
  "m:num",
  "m:den",
  "m:sub",
  "m:sup",
  "m:deg",
  "m:lim",
  "m:fName",
]);
const RUN_ORDER = (name: string) => (name === "m:rPr" ? 0 : name === "w:rPr" ? 1 : 2);

function normaliseOmml(root: XmlNode, noBar: boolean[]): void {
  const fractions = [...descendants(root)].filter((node) => node.name === "m:f");
  if (fractions.length !== noBar.length) throw new LatexToOmmlError("conversion");
  fractions.forEach((fraction, index) => {
    if (!noBar[index]) return;
    const type = [...descendants(fraction)].find((node) => node.name === "m:type");
    if (!type) throw new LatexToOmmlError("conversion");
    type.attributes["m:val"] = "noBar";
  });

  for (const node of descendants(root)) {
    if (node.name === "m:rPr") {
      // CT_RPR: m:nor and m:sty exclude each other; m:sty takes only p, b, i, bi (mathml2omml
      // writes "undefined" for mathvariant="normal").
      const normal = childElements(node).some((child) => child.name === "m:nor");
      node.children = node.children.filter(
        (child) =>
          typeof child === "string" ||
          child.name !== "m:sty" ||
          (!normal && STYLES.has(child.attributes["m:val"] ?? "")),
      );
    }
    if (node.name === "m:r") {
      // CT_R: m:rPr, then w:rPr (an empty one is dropped), then the content.
      node.children = node.children
        .filter(
          (child) =>
            typeof child === "string" ||
            child.name !== "w:rPr" ||
            child.children.length > 0,
        )
        .map((child, index) => ({ child, index }))
        .sort((a, b) => {
          const rank = (c: XmlNode | string) =>
            typeof c === "string" ? 2 : RUN_ORDER(c.name);
          return rank(a.child) - rank(b.child) || a.index - b.index;
        })
        .map(({ child }) => child);
    }
    if (ARGUMENTS.has(node.name)) {
      const first = childElements(node).find((child) => child.name === "m:argPr");
      if (first) {
        node.children = [
          first,
          ...node.children.filter(
            (child) => typeof child === "string" || child.name !== "m:argPr",
          ),
        ];
      }
    }
  }
}

/**
 * One formula (without `$` delimiters) as an `<m:oMath>` XML string. Throws LatexToOmmlError when
 * KaTeX refuses it ("parse"), when its MathML uses an element the converter does not handle
 * ("unsupported"), or when the result is not one well-formed m:oMath ("conversion").
 */
export function latexToOmml(latex: string): string {
  if (latex.trim() === "" || NOT_XML_CHAR.test(latex))
    throw new LatexToOmmlError("parse");

  let mathMl: XmlNode;
  try {
    mathMl = parseXml(toMathMl(latex));
  } catch (error) {
    if (error instanceof LatexToOmmlError) throw error;
    throw new LatexToOmmlError("conversion", { cause: error });
  }
  const noBar = prepareMathMl(mathMl);
  if ([...descendants(mathMl)].some((node) => !SUPPORTED.has(node.name))) {
    throw new LatexToOmmlError("unsupported");
  }

  let omml: XmlNode;
  try {
    // The serialised tree escapes & < > " again; mathml2omml must not decode them, or it writes
    // them back raw (`a<b` inside m:t).
    omml = parseXml(mml2omml(serializeXml(mathMl), { disableDecode: true }));
  } catch (error) {
    throw new LatexToOmmlError("conversion", { cause: error });
  }
  if (
    omml.name !== "m:oMath" ||
    [...descendants(omml)].slice(1).some((n) => n.name === "m:oMath")
  ) {
    throw new LatexToOmmlError("conversion");
  }
  normaliseOmml(omml, noBar);
  const out = serializeXml(omml);
  if (NOT_XML_CHAR.test(out)) throw new LatexToOmmlError("conversion");
  return out;
}
