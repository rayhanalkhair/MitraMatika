// Fonts of the PDF (plan 2026-11-22-react-pdf, decisions 8 and 9b; spike S8; Task 11).
//
// Prose uses Liberation Serif for "times" and Liberation Sans for "arial" (SIL OFL 1.1, metric
// compatible with Times New Roman and Arial, so line breaks match Word's closely), embedded as
// subsets in every PDF. The math symbols Liberation lacks (∠ ⊥ ∥ △ ∈ ⊂ ∪ ∩ ⇒ ∴ and similar) come
// from KaTeX's own TTFs. All fonts are registered from generated base64 modules (never a file path,
// never a URL); the Liberation module is 4 MB, so it is loaded with a dynamic import() by
// `loadPdfFonts()`, which `renderPdf` awaits before it lays a document out. React-PDF's
// `fontFamily` fallback array draws wrong glyphs for some symbols, so `splitByCoverage` splits the
// text itself into runs, each with the one font that really has its characters.
import { Font } from "@react-pdf/renderer";
import "server-only";
import type { TemplateFont } from "@/features/templates";
import { KATEX_FALLBACK } from "../../assets/fonts/katex-fallback.generated";

export { KATEX_FALLBACK };

export const MONO_FAMILY = "Courier";
export const KATEX_MAIN_FAMILY = "KaTeXMain";
export const KATEX_AMS_FAMILY = "KaTeXAMS";
export const KATEX_MATH_FAMILY = "KaTeXMathItalic";

// The cut is 40 code points, not a width: 40 wide letters can overflow a narrow cell (a 4-column
// option), so the layout also breaks overwide words by estimated width (text-width.ts).
/** The longest word the layout may leave unbroken; longer ones wrap in chunks of this size. */
export const MAX_WORD_LENGTH = 40;

export interface FontStyle {
  bold?: boolean;
  italic?: boolean;
}

type Liberation = typeof import("../../assets/fonts/liberation.generated").LIBERATION;
type FaceKey = "regular" | "bold" | "italic" | "boldItalic";

// Each face is registered as a family of its own (normal weight and style), so a family name alone
// selects it and no fontWeight or fontStyle is needed anywhere.
const FACES: Record<
  TemplateFont,
  { source: "serif" | "sans"; names: Record<FaceKey, string> }
> = {
  times: {
    source: "serif",
    names: {
      regular: "LiberationSerif",
      bold: "LiberationSerif-Bold",
      italic: "LiberationSerif-Italic",
      boldItalic: "LiberationSerif-BoldItalic",
    },
  },
  arial: {
    source: "sans",
    names: {
      regular: "LiberationSans",
      bold: "LiberationSans-Bold",
      italic: "LiberationSans-Italic",
      boldItalic: "LiberationSans-BoldItalic",
    },
  },
};

/** The Liberation face for body text in `font`, with bold and italic as separate faces. */
export function pdfFontFamily(font: TemplateFont, style: FontStyle = {}): string {
  const { names } = FACES[font];
  if (style.bold === true && style.italic === true) return names.boldItalic;
  if (style.bold === true) return names.bold;
  if (style.italic === true) return names.italic;
  return names.regular;
}

/** Hyphenation callback: a word of up to 40 characters stays whole, a longer one is cut in chunks. */
export function hyphenateLongWords(word: string): string[] {
  const characters = Array.from(word);
  if (characters.length <= MAX_WORD_LENGTH) return [word];
  const parts: string[] = [];
  for (let at = 0; at < characters.length; at += MAX_WORD_LENGTH) {
    parts.push(characters.slice(at, at + MAX_WORD_LENGTH).join(""));
  }
  return parts;
}

let registered = false;
let liberation: Liberation | undefined;

/**
 * Loads the Liberation fonts (a dynamic import of the generated module, so only the code that
 * renders PDFs carries it) and registers every font. Idempotent; `renderPdf` and the PDF tests
 * await it before laying a document out.
 */
export async function loadPdfFonts(): Promise<void> {
  if (liberation === undefined) {
    ({ LIBERATION: liberation } =
      await import("../../assets/fonts/liberation.generated"));
  }
  ensurePdfFonts();
}

/**
 * Registers the Liberation and KaTeX fonts (data URIs: no fetch, no fs) and the hyphenation
 * callback, once. Needs `loadPdfFonts()` to have completed.
 */
export function ensurePdfFonts(): void {
  if (registered) return;
  if (liberation === undefined) {
    throw new Error("PDF fonts are not loaded: await loadPdfFonts() first.");
  }
  const register = (family: string, base64: string): void => {
    Font.register({ family, src: `data:font/ttf;base64,${base64}` });
  };
  for (const { source, names } of Object.values(FACES)) {
    for (const face of Object.keys(names) as FaceKey[]) {
      register(names[face], liberation[source][face]);
    }
  }
  register(KATEX_MAIN_FAMILY, KATEX_FALLBACK.main);
  register(KATEX_AMS_FAMILY, KATEX_FALLBACK.ams);
  register(KATEX_MATH_FAMILY, KATEX_FALLBACK.math);
  Font.registerHyphenationCallback(hyphenateLongWords);
  registered = true;
}

// --- coverage -------------------------------------------------------------------------------

/** The code points a TrueType font maps to a real glyph (cmap formats 4 and 12). */
function ttfCoverage(bytes: Uint8Array): Set<number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const set = new Set<number>();
  const tableCount = view.getUint16(4);
  let cmap = -1;
  for (let i = 0; i < tableCount; i++) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
    if (tag === "cmap") cmap = view.getUint32(record + 8);
  }
  if (cmap < 0) return set;
  const subtableCount = view.getUint16(cmap + 2);
  for (let i = 0; i < subtableCount; i++) {
    const at = cmap + view.getUint32(cmap + 4 + i * 8 + 4);
    const format = view.getUint16(at);
    if (format === 4) {
      const segments = view.getUint16(at + 6) / 2;
      const ends = at + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const offsets = deltas + segments * 2;
      for (let s = 0; s < segments; s++) {
        const end = view.getUint16(ends + s * 2);
        const start = view.getUint16(starts + s * 2);
        const delta = view.getUint16(deltas + s * 2);
        const offset = view.getUint16(offsets + s * 2);
        for (let code = start; code <= end && code < 0xffff; code++) {
          let glyph: number;
          if (offset === 0) {
            glyph = (code + delta) & 0xffff;
          } else {
            const raw = view.getUint16(offsets + s * 2 + offset + (code - start) * 2);
            glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
          }
          if (glyph !== 0) set.add(code);
        }
      }
    } else if (format === 12) {
      const groups = view.getUint32(at + 12);
      for (let g = 0; g < groups; g++) {
        const start = view.getUint32(at + 16 + g * 12);
        const end = view.getUint32(at + 20 + g * 12);
        for (let code = start; code <= end; code++) set.add(code);
      }
    }
  }
  return set;
}

interface Coverage {
  serif: Set<number>;
  sans: Set<number>;
  main: Set<number>;
  ams: Set<number>;
  math: Set<number>;
}

let coverage: Coverage | undefined;

function fontCoverage(): Coverage {
  if (liberation === undefined) {
    throw new Error("PDF fonts are not loaded: await loadPdfFonts() first.");
  }
  coverage ??= {
    serif: ttfCoverage(Buffer.from(liberation.serif.regular, "base64")),
    sans: ttfCoverage(Buffer.from(liberation.sans.regular, "base64")),
    main: ttfCoverage(Buffer.from(KATEX_FALLBACK.main, "base64")),
    ams: ttfCoverage(Buffer.from(KATEX_FALLBACK.ams, "base64")),
    math: ttfCoverage(Buffer.from(KATEX_FALLBACK.math, "base64")),
  };
  return coverage;
}

/** Characters with no glyph of their own that a cmap may still map: they must never be drawn. */
function isInvisibleFormat(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff ||
    code === 0x00ad ||
    code === 0xfffe ||
    code === 0xffff ||
    code === 0xfffc ||
    code === 0xfffd
  );
}

/**
 * The look-alike hyphens an AI writes. Liberation draws U+2010 as a glyph of its own that text
 * search cannot match and has none at all for U+2011 (the non-breaking hyphen of "siku‑siku",
 * which used to vanish: "sikusiku"), so all of them print as the ordinary hyphen-minus. The real
 * dashes (figure dash, en, em, horizontal bar) and the minus sign U+2212 are in both Liberation
 * faces and stay as they are.
 */
const HYPHEN_LIKE = new Set([0x2010, 0x2011, 0x2043, 0xfe63, 0xff0d]);

/** Arrows and mathematical operators: a MathJax glyph box can draw what no text font has. */
function drawableAsBox(code: number): boolean {
  return code >= 0x2190 && code <= 0x22ff;
}

/**
 * A stretch of prose in one font (`text`), or one character to draw as a MathJax glyph box (`box`;
 * `∉` and `≠`, which KaTeX builds from other glyphs). The caller sets the text run's `fontFamily`
 * and typesets a box run like an inline formula of that one character.
 */
export type PdfRun =
  { kind: "text"; family: string; text: string } | { kind: "box"; text: string };

/**
 * Splits prose into runs by the font that can draw each character: the Liberation face of `font`
 * when it has the character (Latin, Greek, punctuation, arrows and many operators), else the first
 * of KaTeX Main, AMS and Math-Italic that has it; arrows and operators nobody has become glyph
 * boxes. Control characters, invisible format characters, lone surrogates, characters above U+FFFF
 * and anything else no font has are dropped, so nothing prints a wrong glyph.
 */
export function splitByCoverage(
  text: string,
  font: TemplateFont,
  style: FontStyle = {},
): PdfRun[] {
  const base = pdfFontFamily(font, style);
  const runs: PdfRun[] = [];
  const pushText = (family: string, character: string) => {
    const last = runs[runs.length - 1] as PdfRun | undefined;
    if (last?.kind === "text" && last.family === family) last.text += character;
    else runs.push({ kind: "text", family, text: character });
  };
  const covers = fontCoverage();
  const body = covers[FACES[font].source];
  for (const character of text.normalize("NFC")) {
    const code = character === "\t" ? 0x20 : (character.codePointAt(0) ?? 0);
    if (HYPHEN_LIKE.has(code)) {
      pushText(base, "-");
      continue;
    }
    if (code === 0x0a || code === 0x20) {
      pushText(base, code === 0x20 ? " " : character);
      continue;
    }
    if (
      code < 0x20 ||
      (code >= 0x7f && code < 0xa0) ||
      code > 0xffff ||
      (code >= 0xd800 && code <= 0xdfff) ||
      isInvisibleFormat(code)
    )
      continue;
    if (body.has(code)) pushText(base, character);
    else if (covers.main.has(code)) pushText(KATEX_MAIN_FAMILY, character);
    else if (covers.ams.has(code)) pushText(KATEX_AMS_FAMILY, character);
    else if (covers.math.has(code)) pushText(KATEX_MATH_FAMILY, character);
    else if (drawableAsBox(code)) runs.push({ kind: "box", text: character });
  }
  return runs;
}
