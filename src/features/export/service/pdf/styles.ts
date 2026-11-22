// Sizes and style helpers of the PDF layout (print-css.ts is the model: 12 pt body, 1.4 line height).
import type { Styles } from "@react-pdf/renderer";
import type { TemplateFont } from "@/features/templates";

/** One React-PDF style object. */
export type PdfStyle = Styles[string];

export const BODY_PT = 12;
export const LINE_HEIGHT = 1.4;
/** Superscripts (unit exponents) are set at this share of the text size. */
export const SUP_SCALE = 0.7;
/** Space between paragraphs of a question (`p { margin: 0 0 3pt }`). */
export const PARAGRAPH_GAP = 3;
/** Space after a question (`.item { margin: 0 0 9pt }`). */
export const ITEM_GAP = 9;
/** Item number column: a 20 pt right-aligned number, then 8 pt. */
export const NUMBER_WIDTH = 20;
export const NUMBER_GAP = 8;
export const NUMBER_COLUMN = NUMBER_WIDTH + NUMBER_GAP;
/** Option label ("A.") column and the gap between columns of options. */
export const LABEL_WIDTH = 14;
export const LABEL_GAP = 5;
export const OPTION_GAP = 14;
/** Indent of the numbered steps of a solution (`ol.steps { padding-left: 18pt }`). */
export const STEP_INDENT = 18;
/**
 * React-PDF lays the rest of a flow out again at every page break, so time and memory grow with
 * the square of the pages in one flow (200 items: 60 s, 2 GB). A flow is therefore cut into a new
 * Page element once its estimated height reaches this many pages; the estimator runs 16 to 25 %
 * high, so a flow is really about 10 pages. The cost is one partly empty page per cut.
 */
export const FLOW_PAGES = 6;
/** Heading plus the first lines of the first item must fit together (spike S4). */
export const HEADING_MIN_PRESENCE = 90;
/** An item is kept whole on one page only when its estimated height is at most this share. */
export const WHOLE_ITEM_SHARE = 0.9;

// Where the baseline sits in a text box of the line height above, measured from the bottom edge
// (spike S3). A formula drawn next to text is shifted by this much minus its own depth.
export const BASELINE_EM = 0.5;

/** The width of a space, in em, for the two body fonts (Times 250, Helvetica 278 units). */
export const SPACE_EM: Record<TemplateFont, number> = { times: 0.25, arial: 0.278 };

/**
 * The style of every Text. fontSize and lineHeight are set on the Text itself and never on a Page
 * or View: a line height anywhere else breaks pagination, and a unitless one on a Text whose size
 * is only inherited is multiplied by the 18 pt default (spike F5).
 */
export function textStyle(
  fontFamily: string,
  fontSize = BODY_PT,
  extra: PdfStyle = {},
): PdfStyle {
  return { fontFamily, fontSize, lineHeight: LINE_HEIGHT, ...extra };
}
