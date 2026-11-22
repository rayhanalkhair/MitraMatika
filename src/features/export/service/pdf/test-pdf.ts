// Helpers for the PDF tests: render a document model for real and read the result back.
import { renderToBuffer } from "@react-pdf/renderer";
import { isValidElement, type ReactElement } from "react";
import { getDocumentProxy } from "unpdf";
import type { ExportDocument } from "../document-model";
import type { DocumentKind } from "../render-html";
import type { PdfContext } from "./context";
import { ExportPdfDocument } from "./document";
import { loadPdfFonts } from "./fonts";
import { createMathCache, type MathCache } from "./math-box";

export function newContext(math: MathCache = createMathCache()): PdfContext {
  return { warnings: [], where: { part: "instructions" }, math };
}

export interface RenderedPdf {
  bytes: Uint8Array;
  ctx: PdfContext;
}

/** Lays the document out and renders it to PDF bytes (the real thing: no mocks). */
export async function renderForTest(
  doc: ExportDocument,
  kind: DocumentKind,
  ctx: PdfContext = newContext(),
  flowPages?: number,
): Promise<RenderedPdf> {
  await loadPdfFonts();
  const buffer = await renderToBuffer(ExportPdfDocument({ doc, kind, ctx, flowPages }));
  return { bytes: new Uint8Array(buffer), ctx };
}

export interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
}

export interface PdfPage {
  width: number;
  height: number;
  text: string;
  items: TextItem[];
}

/** Each page's size, text and positioned text items. */
export async function readPages(bytes: Uint8Array): Promise<PdfPage[]> {
  const pdf = await getDocumentProxy(bytes.slice());
  const pages: PdfPage[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const [x0, y0, x1, y1] = page.view;
    const content = await page.getTextContent();
    const items = content.items.flatMap((item) => {
      if (!("str" in item) || item.str.trim() === "") return [];
      const transform = item.transform as number[];
      return [{ text: item.str, x: transform[4], y: transform[5], width: item.width }];
    });
    pages.push({
      width: x1 - x0,
      height: y1 - y0,
      text: items.map((item) => item.text).join(" "),
      items,
    });
  }
  return pages;
}

/** The document information (Title, Author, Creator, Producer ...) of a PDF. */
export async function readInfo(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const pdf = await getDocumentProxy(bytes.slice());
  const { info } = await pdf.getMetadata();
  return info as Record<string, unknown>;
}

/** An element whose props are read loosely, as the tree tests do. */
export type LooseElement = ReactElement<Record<string, unknown>>;

/** Every React element of a tree, depth first (function components are not expanded). */
export function elementsOf(node: unknown): LooseElement[] {
  if (Array.isArray(node)) return node.flatMap((child: unknown) => elementsOf(child));
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elementsOf(node.props.children)];
}

/** All the text strings of a tree, in order. */
export function stringsOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap((child: unknown) => stringsOf(child));
  if (typeof node === "string") return [node];
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return stringsOf(node.props.children);
}
