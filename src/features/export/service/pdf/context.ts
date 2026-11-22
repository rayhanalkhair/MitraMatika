// What the PDF components share: the warning sink, the page geometry and the formula cache.
import type { PaperSize, TemplateFont } from "@/features/templates";
import type { LogoOmittedWarning } from "../warnings";
import type { RenderWarning, WarningWhere } from "../rich-text";
import type { MathCache } from "./math-box";

/**
 * One render's mutable state. The components are plain functions run once while the element tree
 * is built, so `where` can be set before each piece of text exactly as `render-html.ts` does.
 */
export interface PdfContext {
  warnings: (RenderWarning | LogoOmittedWarning)[];
  /** Set by the caller before each piece of text. */
  where: WarningWhere;
  math: MathCache;
}

/** 1 mm in PDF points. */
export const MM = 72 / 25.4;

/** A4 and F4 (215 x 330 mm, D-014) in points. */
export const PAGE_PT: Record<PaperSize, [number, number]> = {
  A4: [595.28, 841.89],
  F4: [609.45, 935.43],
};

/** The margins of `print-css.ts`: 18 / 18 / 22 / 18 mm. */
export const MARGIN_PT = {
  top: 18 * MM,
  right: 18 * MM,
  bottom: 22 * MM,
  left: 18 * MM,
} as const;

/** The printable area and the body font of one document. */
export interface PdfLayout {
  font: TemplateFont;
  /** Width between the left and right margins. */
  contentWidth: number;
  /** Height between the top and bottom margins: what one page can hold. */
  contentHeight: number;
}

export function layoutFor(paper: PaperSize, font: TemplateFont): PdfLayout {
  const [width, height] = PAGE_PT[paper];
  return {
    font,
    contentWidth: width - MARGIN_PT.left - MARGIN_PT.right,
    contentHeight: height - MARGIN_PT.top - MARGIN_PT.bottom,
  };
}
