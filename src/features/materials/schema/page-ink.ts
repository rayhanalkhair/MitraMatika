// Whether a page picture shows anything (Task 6 review I1). A scanned page whose images pdf.js
// could not decode renders white; sending it to OCR would spend the teacher's daily cap on
// nothing. Used by the browser before it uploads a page and by the job before it sends one.

/** A pixel this dark (luminance 0-255) and this opaque counts as ink. */
export const INK_LUMA = 160;
const OPAQUE = 128;
/** Below this share of ink pixels a page is blank (a lone page number stays below it). */
export const MIN_INK_SHARE = 0.001;

/** The share of ink pixels in 8-bit RGBA data. */
export function inkShare(rgba: ArrayLike<number>): number {
  const pixels = Math.floor(rgba.length / 4);
  if (pixels === 0) return 0;
  let ink = 0;
  for (let i = 0; i < pixels * 4; i += 4) {
    if (rgba[i + 3] < OPAQUE) continue;
    const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    if (luma < INK_LUMA) ink += 1;
  }
  return ink / pixels;
}

export const isBlankShare = (share: number) => share < MIN_INK_SHARE;
