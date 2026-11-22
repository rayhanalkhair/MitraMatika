// The PDF document (plan 2026-11-22-react-pdf, decisions 1 to 3 and 11): paper, key or solutions
// from the same ExportDocument the HTML preview and the Word file read.
import { Document, Page, Text, type DocumentProps } from "@react-pdf/renderer";
import "server-only";
import type { ReactElement } from "react";
import type { ExportDocument } from "../document-model";
import { DOCUMENT_TITLES, type DocumentKind } from "../render-html";
import { xmlSafe } from "../xml";
import { layoutFor, MARGIN_PT, PAGE_PT, type PdfContext } from "./context";
import { ensurePdfFonts, pdfFontFamily } from "./fonts";
import { keyTable } from "./key";
import { letterhead } from "./letterhead";
import {
  instructionsBox,
  paperItem,
  sectionHeading,
  studentBlock,
  titleBlock,
} from "./paper";
import { solutionItem } from "./solutions";
import { BODY_PT, FLOW_PAGES } from "./styles";

export { PAGE_PT };
export type { PdfContext };

// No lineHeight here: a `fixed` Text with a `render` prop and a line height makes the layout
// produce an undefined height and the render throws (spike F5).
function footer(doc: ExportDocument): ReactElement {
  return (
    <Text
      key="footer"
      fixed
      style={{
        position: "absolute",
        bottom: MARGIN_PT.bottom / 2 - 5,
        left: 0,
        right: 0,
        textAlign: "center",
        fontSize: 10,
        fontFamily: pdfFontFamily(doc.page.font),
      }}
      render={({ pageNumber, totalPages }) =>
        `Halaman ${String(pageNumber)} dari ${String(totalPages)}`
      }
    />
  );
}

const present = (nodes: (ReactElement | null)[]): ReactElement[] =>
  nodes.filter((node): node is ReactElement => node !== null);

/** The content of the document as groups of nodes; each group becomes one flow (one Page element). */
function body(
  doc: ExportDocument,
  kind: DocumentKind,
  ctx: PdfContext,
  flowPages: number,
): ReactElement[][] {
  const lay = layoutFor(doc.page.paper, doc.page.font);
  const head: (ReactElement | null)[] = [
    letterhead(doc, ctx, lay),
    titleBlock(doc, kind, lay),
  ];
  if (kind === "key") return [present([...head, keyTable(doc, lay)])];
  if (kind === "paper") {
    head.push(studentBlock(doc, lay));
    if (doc.meta.instructionsMd !== null && doc.meta.instructionsMd !== "") {
      head.push(instructionsBox(doc.meta.instructionsMd, ctx, lay));
    }
  }
  const groups: ReactElement[][] = [present(head)];
  let current = groups[0];
  let flowPt = 0;
  for (const [index, section] of doc.sections.entries()) {
    // The heading (and the section's instructions) travel with the first item: the cut is
    // decided for them together, so a heading is never the last thing of a flow.
    const heading = sectionHeading(section, index, ctx, lay);
    let pending = heading.nodes;
    let pendingPt = heading.heightPt;
    for (const item of section.items) {
      const placed =
        kind === "paper" ? paperItem(item, ctx, lay) : solutionItem(item, ctx, lay);
      if (
        flowPt > 0 &&
        flowPt + pendingPt + placed.heightPt > flowPages * lay.contentHeight
      ) {
        current = [];
        groups.push(current);
        flowPt = 0;
      }
      current.push(...pending, placed.node);
      flowPt += pendingPt + placed.heightPt;
      pending = [];
      pendingPt = 0;
    }
    // A section without items still prints its heading.
    current.push(...pending);
    flowPt += pendingPt;
  }
  return groups;
}

/**
 * The document as a React-PDF tree. A plain function: it builds the whole tree (and fills
 * `ctx.warnings`) when called, so `renderToBuffer(ExportPdfDocument({ doc, kind, ctx }))` and the
 * element-tree tests read the same thing. Metadata has no personal data: no author, subject or
 * keywords (decision 11).
 */
export function ExportPdfDocument(props: {
  doc: ExportDocument;
  kind: DocumentKind;
  ctx: PdfContext;
  /** Pages of estimated height after which a flow is cut (default `FLOW_PAGES`; tests lower it). */
  flowPages?: number;
}): ReactElement<DocumentProps> {
  const { doc, kind, ctx } = props;
  ensurePdfFonts();
  const content = body(doc, kind, ctx, props.flowPages ?? FLOW_PAGES);
  return (
    <Document
      title={xmlSafe(`${DOCUMENT_TITLES[kind]} - ${doc.meta.title}`)}
      creator="MitraMatika"
      producer="MitraMatika"
      language="id"
    >
      {content.map((group, index) => (
        <Page
          key={index}
          size={PAGE_PT[doc.page.paper]}
          style={{
            paddingTop: MARGIN_PT.top,
            paddingBottom: MARGIN_PT.bottom,
            paddingLeft: MARGIN_PT.left,
            paddingRight: MARGIN_PT.right,
            fontFamily: pdfFontFamily(doc.page.font),
            fontSize: BODY_PT,
          }}
        >
          {group}
          {footer(doc)}
        </Page>
      ))}
    </Document>
  );
}
