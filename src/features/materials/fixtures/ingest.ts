// Ingestion fixtures (Task 4), built in the test so no binary file is checked in. Each one is the
// smallest file that shows one ingestion rule.
import { randomBytes } from "node:crypto";
import JSZip from "jszip";

const encoder = new TextEncoder();

/** A PDF string literal: backslashes and parentheses escaped (ASCII text only). */
const pdfString = (text: string) => `(${text.replace(/([\\()])/g, "\\$1")})`;

function assemble(objects: (string | Uint8Array)[]): Uint8Array {
  const chunks: Uint8Array[] = [encoder.encode("%PDF-1.4\n")];
  let length = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(length);
    const head = encoder.encode(`${String(index + 1)} 0 obj\n`);
    const body = typeof object === "string" ? encoder.encode(object) : object;
    const tail = encoder.encode("\nendobj\n");
    chunks.push(head, body, tail);
    length += head.length + body.length + tail.length;
  });
  let xref = `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(length)}\n%%EOF\n`;
  chunks.push(encoder.encode(xref));
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * A PDF with a real text layer: one page per entry of `pages`, each entry's lines drawn in
 * Helvetica (ASCII only); pdf.js leaves out text outside the page, so long lines need `width`.
 * `count` makes the page tree lie about its /Count. Objects: 1 catalog, 2 page tree, 3 font, then
 * a page and its content.
 */
export function makeTextPdf(
  pages: string[][],
  options: { width?: number; count?: number } = {},
): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(" ")}] /Count ${String(options.count ?? pages.length)} >>`,
  );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((lines, i) => {
    const stream = [
      "BT /F1 9 Tf 12 TL 20 560 Td",
      ...lines.map((line) => `${pdfString(line)} Tj T*`),
      "ET",
    ].join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(options.width ?? 420)} 595] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(5 + i * 2)} 0 R >>`,
    );
    objects.push(
      `<< /Length ${String(encoder.encode(stream).length)} >>\nstream\n${stream}\nendstream`,
    );
  });
  return assemble(objects);
}

/** What a scanner produces: one page that is only a picture (a 2 x 2 grey image), no text. */
export function makeScannedPdf(): Uint8Array {
  const pixels = new Uint8Array([0x40, 0x80, 0xc0, 0xff]);
  const draw = "q 420 0 0 595 0 0 cm /Im1 Do Q";
  return assemble([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
    new Uint8Array(
      Buffer.concat([
        encoder.encode(
          "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n",
        ),
        pixels,
        encoder.encode("\nendstream"),
      ]),
    ),
    `<< /Length ${String(draw.length)} >>\nstream\n${draw}\nendstream`,
  ]);
}

/** A paragraph of ordinary Indonesian textbook prose (about 280 characters). */
export const PROSE =
  "Pola bilangan adalah susunan bilangan yang memiliki aturan tertentu. Pada bab ini kalian " +
  "akan mempelajari cara menemukan aturan sebuah pola dan menggunakannya untuk menentukan " +
  "suku berikutnya. Perhatikan contoh berikut dengan saksama sebelum mengerjakan latihan.";

/** Splits text into lines of at most `width` characters (a PDF line is drawn as one string). */
export function lines(text: string, width = 70): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

/**
 * A DOCX whose body is `body` (WordprocessingML with the w: and m: prefixes declared). `padding`
 * adds a stored entry of that many random bytes, so a highly compressible part stays inside
 * finalise's 20x inflate ratio (how the review of Task 4 built its stress files).
 */
export function makeDocxBody(
  body: string,
  options: { padding?: number } = {},
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", RELS);
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}" xmlns:m="${M_NS}"><w:body>${body}</w:body></w:document>`,
  );
  if (options.padding) {
    zip.file("word/media/padding.bin", randomBytes(options.padding), {
      compression: "STORE",
    });
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** `depth` nested content controls (`w:sdt`) around one paragraph, the review's 0.1 MB stall. */
export function makeNestedDocx(depth: number): Promise<Uint8Array> {
  const open = "<w:sdt><w:sdtContent>".repeat(depth);
  const close = "</w:sdtContent></w:sdt>".repeat(depth);
  return makeDocxBody(`${open}${para("dalam")}${close}`, { padding: (depth * 45) / 10 });
}

/** A document part of about `bytes` of short paragraphs (the review's memory test). */
export function makeLargeDocx(bytes: number): Promise<Uint8Array> {
  const paragraph = para("Baris pendek nomor tiga puluh.");
  const count = Math.ceil(bytes / paragraph.length);
  return makeDocxBody(paragraph.repeat(count), { padding: Math.ceil(bytes / 10) });
}

/** A paragraph of plain runs. */
export const para = (...runs: string[]) =>
  `<w:p>${runs.map((text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`).join("")}</w:p>`;

/** A math run (`m:r`) with its text. */
export const mr = (text: string) => `<m:r><m:t>${text}</m:t></m:r>`;

/** The equations of the DOCX fixture: the supported set and one matrix (not supported). */
export const EQUATIONS = {
  fraction: `<m:oMath><m:f><m:num>${mr("a")}</m:num><m:den>${mr("b")}</m:den></m:f></m:oMath>`,
  root: `<m:oMath><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${mr("x")}</m:e></m:rad></m:oMath>`,
  power: `<m:oMath><m:sSup><m:e>${mr("x")}</m:e><m:sup>${mr("2")}</m:sup></m:sSup>${mr("+1")}</m:oMath>`,
  brackets: `<m:oMath><m:sSup><m:e><m:d><m:e>${mr("a+b")}</m:e></m:d></m:e><m:sup>${mr("2")}</m:sup></m:sSup></m:oMath>`,
  matrix: `<m:oMath><m:m><m:mr><m:e>${mr("1")}</m:e><m:e>${mr("2")}</m:e></m:mr></m:m></m:oMath>`,
};

/** A DOCX with prose, inline equations of the supported set, a display equation and a matrix. */
export function makeEquationDocx(): Promise<Uint8Array> {
  return makeDocxBody(
    [
      para(PROSE),
      `<w:p><w:r><w:t xml:space="preserve">Pecahan </w:t></w:r>${EQUATIONS.fraction}<w:r><w:t xml:space="preserve"> dan akar </w:t></w:r>${EQUATIONS.root}<w:r><w:t xml:space="preserve"> serta pangkat </w:t></w:r>${EQUATIONS.power}</w:p>`,
      `<w:p><m:oMathPara>${EQUATIONS.brackets}</m:oMathPara></w:p>`,
      `<w:p><w:r><w:t xml:space="preserve">Matriks </w:t></w:r>${EQUATIONS.matrix}</w:p>`,
    ].join(""),
  );
}
