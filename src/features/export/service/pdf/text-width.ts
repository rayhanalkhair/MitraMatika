// A cheap estimate of how wide prose is, used for one thing: cutting a word that cannot fit its
// column. React-PDF's hyphenation callback only sees the word, never the column, so a cut at a
// fixed number of characters (fonts.ts) is too coarse for a narrow option cell (40 capital Ws
// are about 450 pt wide, a 4-column option holds about 85 pt). The layout therefore breaks such a
// word itself, at estimated widths, with a hard line break.
//
// The widths are the advance widths of the Times and Helvetica faces (Adobe AFM, in 1/1000 em) for
// U+0020..U+007E, which Liberation Serif and Sans match by design (they are metric-compatible with
// Times New Roman and Arial); bold is estimated 8 % wider; anything else is estimated generously.

// prettier-ignore
const TIMES = [
  250, 333, 408, 500, 500, 833, 778, 333, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
  921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
  556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
  333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
  500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
];

// prettier-ignore
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Width of the widest ASCII glyph of the two faces (W), used for anything not in the tables. */
const WIDEST_EM = 0.944;
/** Everything else (accents, KaTeX symbols): a generous guess. */
const OTHER_EM = 0.8;
const COURIER_EM = 0.6;
const BOLD_FACTOR = 1.08;

// Sans faces use the Helvetica widths and Liberation Serif the Times widths (the names are the PDF
// families of fonts.ts). Everything else (the KaTeX fonts) is estimated with the Times table and
// generous widths for characters outside ASCII.
const SANS_FAMILY = /^(Helvetica|Arial|LiberationSans|Liberation Sans)/;

/** Estimated width of one character, in em. */
export function charWidthEm(character: string, family: string): number {
  if (family.startsWith("Courier")) return COURIER_EM;
  const code = character.codePointAt(0) ?? 0;
  const sans = SANS_FAMILY.test(family);
  const table = sans ? HELVETICA : TIMES;
  const base =
    code >= 0x20 && code <= 0x7e
      ? table[code - 0x20] / 1000
      : sans || family.startsWith("Times") || family.startsWith("LiberationSerif")
        ? code === 0x0a
          ? 0
          : OTHER_EM
        : WIDEST_EM;
  return family.includes("Bold") ? base * BOLD_FACTOR : base;
}

/** Estimated width of `text` in points. */
export function estimateWidth(text: string, family: string, fontSize: number): number {
  let em = 0;
  for (const character of text) em += charWidthEm(character, family);
  return em * fontSize;
}

/** Cut a word into pieces that each fit `widthPt` (by estimate, with a small safety margin). */
function cutToWidth(
  word: string,
  family: string,
  fontSize: number,
  widthPt: number,
): string[] {
  const limit = widthPt * 0.92;
  const pieces: string[] = [];
  let piece = "";
  let used = 0;
  for (const character of word) {
    const width = charWidthEm(character, family) * fontSize;
    if (piece !== "" && used + width > limit) {
      pieces.push(piece);
      piece = "";
      used = 0;
    }
    piece += character;
    used += width;
  }
  if (piece !== "") pieces.push(piece);
  return pieces;
}

/**
 * Splits `text` where a word is estimated wider than `widthPt`: the result is lines of text that
 * the caller joins with hard line breaks. Text without such a word comes back as one segment.
 */
export function breakOverwideWords(
  text: string,
  family: string,
  fontSize: number,
  widthPt: number,
): string[] {
  if (widthPt <= 0 || estimateWidth(text, family, fontSize) <= widthPt) return [text];
  const segments: string[] = [];
  let current = "";
  for (const token of text.split(/(\s+)/)) {
    if (token === "" || /^\s+$/.test(token)) {
      current += token;
    } else if (estimateWidth(token, family, fontSize) <= widthPt) {
      current += token;
    } else {
      const pieces = cutToWidth(token, family, fontSize, widthPt);
      segments.push(current + (pieces[0] ?? ""));
      for (const piece of pieces.slice(1, -1)) segments.push(piece);
      current = pieces.length > 1 ? (pieces.at(-1) ?? "") : "";
    }
  }
  segments.push(current);
  return segments.filter((segment) => segment !== "");
}
