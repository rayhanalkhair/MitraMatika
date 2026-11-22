// Width fit of a formula in the PDF (plan decision 6, R31 kept). The PDF knows the exact width of
// a typeset formula, so unlike the HTML estimate it needs no unit guess: the largest of 100, 90,
// 80 and 70 % that fits the available width wins, and one still too wide at 70 % is drawn at 70 %
// and reported (`mathTooWide`).
import { FIT_SIZES } from "../rich-text";

export type MathScale = 1 | 0.9 | 0.8 | 0.7;

export interface MathFit {
  scale: MathScale;
  tooWide: boolean;
}

const SCALES = [1, ...FIT_SIZES.map((size) => size / 100)] as MathScale[];

/** The scale at which a formula `widthPt` wide fits `availablePt`, and whether none does. */
export function fitMath(widthPt: number, availablePt: number): MathFit {
  const fitting = SCALES.find((scale) => widthPt * scale <= availablePt);
  return fitting === undefined
    ? { scale: SCALES[SCALES.length - 1], tooWide: true }
    : { scale: fitting, tooWide: false };
}
