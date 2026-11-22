// The HTML renderer (the in-app preview; the PDF is laid out from the same model by
// React-PDF, ADR-0021). One self-contained string: KaTeX rendered at build time with its stylesheet
// and fonts inlined, no URL of any kind, no script, a CSP meta that allows only inline styles and
// data: images and fonts. The text is Indonesian whatever the UI language is.
import "server-only";
import type { PaperSize, TemplateFont } from "@/features/templates";
import { printCss } from "../assets/print-css";
import { keyRows, type ExportDocument, type ExportItem } from "./document-model";
import { katexInlineCss } from "./katex-assets";
import {
  escapeHtml as esc,
  renderRich,
  type RenderWarning,
  type RichContext,
} from "./rich-text";

export type { RenderWarning } from "./rich-text";
export type DocumentKind = "paper" | "key" | "solutions";
export interface RenderOptions {
  paper: PaperSize;
  font: TemplateFont;
}

const CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
const FOOTER = "Halaman {page} dari {pages}";
/** The document's title line, also the PDF's and the browser tab's. */
export const DOCUMENT_TITLES: Record<DocumentKind, string> = {
  paper: "Naskah Soal",
  key: "Kunci Jawaban",
  solutions: "Pembahasan",
};

/** 20 -> "20", 2.5 -> "2,5", 0.125 -> "0,13" (Indonesian decimal comma, at most 2 places). */
export function formatPoints(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded).replace(".", ",");
}

function letterhead(doc: ExportDocument): string {
  const { logoDataUri, lines, schoolName } = doc.header;
  const text = [
    ...lines.map((line) => `<span class="line">${esc(line)}</span>`),
    schoolName ? `<span class="school">${esc(schoolName)}</span>` : "",
  ].join("");
  if (text === "" && !logoDataUri) return "";
  return `<header class="letterhead">${
    logoDataUri
      ? `<img class="logo" src="${logoDataUri}" alt="">`
      : '<div class="spacer"></div>'
  }<div class="text">${text}</div><div class="spacer"></div></header>`;
}

function titleBlock(doc: ExportDocument, kind: DocumentKind): string {
  const { meta } = doc;
  const rows: [string, string][] = [
    ["Mata pelajaran", meta.subject],
    ["Kelas", String(meta.grade)],
  ];
  if (meta.examDate) rows.push(["Hari, tanggal", meta.examDate]);
  if (meta.durationMinutes !== null) {
    rows.push(["Waktu", `${String(meta.durationMinutes)} menit`]);
  }
  return `<h1>${DOCUMENT_TITLES[kind]}</h1><p class="subtitle">${esc(meta.title)} (${esc(meta.kindLabel)})</p>
<table class="meta">${rows
    .map(([label, value]) => `<tr><th>${label}</th><td>: ${esc(value)}</td></tr>`)
    .join("")}</table>`;
}

function studentBlock(doc: ExportDocument): string {
  if (doc.studentFields.length === 0) return "";
  return `<div class="student">${doc.studentFields
    .map(
      ({ label }) =>
        `<div class="field"><span>${esc(label)}</span><span class="blank"></span></div>`,
    )
    .join("")}</div>`;
}

function paperItem(item: ExportItem, ctx: RichContext): string {
  ctx.where = { part: "stem", number: item.number };
  const stem = renderRich(item.stemMd, ctx);
  const options = (item.options ?? [])
    .map((option) => {
      ctx.where = { part: "option", number: item.number, label: option.label };
      return `<div class="opt"><span class="lbl">${option.label}.</span><span class="txt">${renderRich(option.textMd, ctx, true)}</span></div>`;
    })
    .join("");
  return `<div class="item" id="q-${String(item.number)}"><div class="num">${String(item.number)}.</div><div class="body"><div class="stem">${stem}</div>${
    options ? `<div class="options cols-${String(item.columns)}">${options}</div>` : ""
  }</div></div>`;
}

function solutionItem(item: ExportItem, ctx: RichContext): string {
  const n = String(item.number);
  ctx.where = { part: "stem", number: item.number };
  const stem = renderRich(item.stemMd, ctx);
  const correct = item.options?.find((option) => option.label === item.answerMd);
  let answer = `Jawaban: ${esc(item.answerMd)}`;
  if (correct) {
    ctx.where = { part: "option", number: item.number, label: correct.label };
    answer += `. ${renderRich(correct.textMd, ctx, true)}`;
  }
  const steps = item.steps
    .map((step, index) => {
      ctx.where = { part: "step", number: item.number, step: index + 1 };
      return `<li>${renderRich(step, ctx, true)}</li>`;
    })
    .join("");
  return `<div class="item" id="q-${n}"><div class="num">${n}.</div><div class="body"><div class="stem">${stem}</div><p class="answer">${answer}</p>${
    steps ? `<ol class="steps">${steps}</ol>` : ""
  }</div></div>`;
}

function keyTable(doc: ExportDocument): string {
  const rows = keyRows(doc);
  const total = rows.reduce((sum, row) => sum + Math.round(row.points * 100), 0) / 100;
  return `<table class="key"><thead><tr><th>No</th><th>Jawaban</th><th>Skor</th></tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr class="key-row"><td>${String(row.number)}</td><td>${esc(row.answer)}</td><td>${formatPoints(row.points)}</td></tr>`,
    )
    .join(
      "",
    )}</tbody><tfoot><tr><td colspan="2">Total</td><td>${formatPoints(total)}</td></tr></tfoot></table>`;
}

function body(doc: ExportDocument, kind: DocumentKind, ctx: RichContext): string {
  const parts = [letterhead(doc), titleBlock(doc, kind)];
  if (kind === "key") {
    parts.push(keyTable(doc));
    return parts.join("");
  }
  if (kind === "paper") {
    parts.push(studentBlock(doc));
    if (doc.meta.instructionsMd) {
      ctx.where = { part: "instructions" };
      parts.push(
        `<div class="instructions"><strong>Petunjuk:</strong>${renderRich(doc.meta.instructionsMd, ctx)}</div>`,
      );
    }
  }
  for (const section of doc.sections) {
    parts.push(`<section><h2>${esc(section.title)}</h2>`);
    if (section.instructionsMd) {
      ctx.where = { part: "sectionInstructions", section: section.title };
      parts.push(
        `<div class="section-instructions">${renderRich(section.instructionsMd, ctx)}</div>`,
      );
    }
    parts.push(
      ...section.items.map((item) =>
        kind === "paper" ? paperItem(item, ctx) : solutionItem(item, ctx),
      ),
      "</section>",
    );
  }
  return parts.join("");
}

/** The document as one HTML string, with the math failures that fell back to plain text. */
export function renderDocument(
  doc: ExportDocument,
  kind: DocumentKind,
  options: RenderOptions,
): { html: string; warnings: RenderWarning[] } {
  const ctx: RichContext = {
    warnings: [],
    where: { part: "instructions" },
    usedMath: false,
  };
  const content = body(doc, kind, ctx);
  const html = `<!doctype html>
<html lang="id" data-paper="${options.paper}" data-footer="${FOOTER}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`${DOCUMENT_TITLES[kind]} - ${doc.meta.title}`)}</title>
<style>${printCss(options.paper, options.font)}</style>${
    ctx.usedMath ? `\n<style>${katexInlineCss()}</style>` : ""
  }
</head>
<body><main class="sheet">${content}</main></body>
</html>
`;
  return { html, warnings: ctx.warnings };
}

export const renderHtml = (
  doc: ExportDocument,
  kind: DocumentKind,
  options: RenderOptions,
): string => renderDocument(doc, kind, options).html;
