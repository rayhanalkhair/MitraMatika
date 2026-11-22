// The print stylesheet of the exported documents (A4 / F4, Times New Roman or Arial 12 pt). A TS
// module rather than a .css file so it is bundled with the server code and needs no file at run
// time. The page size comes from `@page`; F4 is 215 x 330 mm (D-014). This stylesheet serves the
// in-app preview only (the PDF is laid out by React-PDF, ADR-0021, with the same margins). The
// footer "Halaman x dari y" uses a page margin box with CSS counters. The same words sit in the
// data-footer attribute.
// A display formula is never clipped in print: rich-text.ts sets a wide one smaller (the fit-*
// classes) and warns when even the smallest size may run past the edge (overflow stays visible).
import type { PaperSize, TemplateFont } from "@/features/templates";

export const PAPER_MM: Record<PaperSize, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  F4: { width: 215, height: 330 },
};

// Liberation Serif / Sans are metric-compatible with Times New Roman / Arial. They are named
// second so a machine with the real font uses it; a server with Liberation installed matches the
// layout. (Embedding the font files is the PDF job's follow-up in ADR-0013.)
export const FONT_STACKS: Record<TemplateFont, string> = {
  times: '"Times New Roman", "Liberation Serif", Times, serif',
  arial: 'Arial, "Liberation Sans", Helvetica, sans-serif',
};

export function printCss(paper: PaperSize, font: TemplateFont): string {
  const { width, height } = PAPER_MM[paper];
  return `
@page {
  size: ${String(width)}mm ${String(height)}mm;
  margin: 18mm 18mm 22mm 18mm;
  @bottom-center {
    content: "Halaman " counter(page) " dari " counter(pages);
    font-family: ${FONT_STACKS[font]};
    font-size: 10pt;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0;
  font-family: ${FONT_STACKS[font]};
  font-size: 12pt;
  line-height: 1.4;
  color: #000;
  background: #fff;
}
.sheet { width: 100%; overflow-wrap: anywhere; }
@media screen {
  body { background: #d9dce1; padding: 16px 0; }
  .sheet {
    width: ${String(width)}mm;
    max-width: calc(100% - 16px);
    min-height: ${String(height)}mm;
    margin: 0 auto;
    padding: 18mm;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  }
  .math-block { overflow-x: auto; }
}
.math-block.fit-90 { font-size: 90%; }
.math-block.fit-80 { font-size: 80%; }
.math-block.fit-70 { font-size: 70%; }
.letterhead {
  display: flex;
  align-items: center;
  gap: 12pt;
  padding-bottom: 6pt;
  border-bottom: 3px double #000;
  text-align: center;
}
.letterhead .logo { width: 20mm; height: 20mm; object-fit: contain; flex: none; }
.letterhead .spacer { width: 20mm; flex: none; }
.letterhead .text { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.2; }
.letterhead .line { font-weight: 700; font-size: 11pt; text-transform: uppercase; }
.letterhead .school { font-weight: 700; font-size: 14pt; }
h1 { font-size: 14pt; text-align: center; margin: 12pt 0 2pt; text-transform: uppercase; }
.subtitle { text-align: center; margin: 0 0 8pt; }
table.meta { border-collapse: collapse; margin: 0 0 8pt; }
table.meta th { text-align: left; font-weight: 400; padding: 0 12pt 0 0; white-space: nowrap; }
table.meta td { padding: 0; }
.student { display: flex; flex-wrap: wrap; gap: 6pt 18pt; margin: 8pt 0; }
.student .field { flex: 1 1 40%; display: flex; gap: 6pt; align-items: baseline; }
.student .blank { flex: 1; border-bottom: 1px dotted #000; min-height: 1em; }
.instructions { border: 1px solid #000; padding: 4pt 8pt; margin: 8pt 0; }
.instructions p { margin: 0 0 3pt; }
h2 { font-size: 12pt; margin: 14pt 0 3pt; break-after: avoid; }
.section-instructions p { margin: 0 0 3pt; font-style: italic; }
.item {
  break-inside: avoid;
  page-break-inside: avoid;
  display: flex;
  gap: 8pt;
  margin: 0 0 9pt;
}
.item .num { flex: none; min-width: 20pt; text-align: right; }
.item .body { flex: 1; min-width: 0; }
.stem p, .opt p { margin: 0 0 3pt; }
.math-block { margin: 3pt 0; max-width: 100%; }
.options { display: grid; gap: 2pt 14pt; margin-top: 3pt; }
.options.cols-1 { grid-template-columns: minmax(0, 1fr); }
.options.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.options.cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.opt { display: flex; gap: 5pt; }
.opt .lbl { flex: none; }
.opt .txt { min-width: 0; }
table.key { border-collapse: collapse; margin: 10pt auto; min-width: 60%; }
table.key th, table.key td { border: 1px solid #000; padding: 3pt 10pt; text-align: center; }
table.key tr { break-inside: avoid; }
table.key tfoot td { font-weight: 700; }
.answer { margin: 2pt 0; font-weight: 700; }
ol.steps { margin: 2pt 0 0; padding-left: 18pt; }
ol.steps li { margin: 0 0 2pt; }
.math-fallback { font-family: "Courier New", monospace; }
`.trim();
}
