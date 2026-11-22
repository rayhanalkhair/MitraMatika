// Files the materials and solver specs upload, built in the test so no binary fixture is checked
// in: a three-page PDF with a real text layer (pages 2 and 3 about SPLDV, so the material passes
// the relevance floor for that topic) and a PNG that looks like a scanned page (dark lines on
// white, well above the blank-page threshold of 0.1% ink).
import { crc32, deflateSync } from "node:zlib";

/** A word found only on page 3 of the PDF (the search shows "Ditemukan di hal. 3"). */
export const SEARCH_WORD = "zebrakuning";

// Plain prose: no + = < > symbols, so every page is "clear" (3 or more would ask for a check).
const PAGES = [
  "Bab satu. Buku latihan ini disusun untuk siswa kelas delapan. Bacalah setiap " +
    "penjelasan dengan teliti sebelum mengerjakan latihan di halaman berikutnya.",
  "Sistem persamaan linear dua variabel terdiri atas dua persamaan linear yang memuat " +
    "dua variabel yang sama. Penyelesaiannya adalah pasangan nilai yang memenuhi kedua " +
    "persamaan sekaligus.",
  "Contoh sistem persamaan linear dua variabel: harga dua buku dan tiga pensil adalah " +
    "sembilan ribu rupiah, sedangkan harga satu buku dan satu pensil adalah empat ribu " +
    `rupiah. Tentukan harga satu buku. Kata kunci latihan ini adalah ${SEARCH_WORD}.`,
];

/** Lines of at most 70 characters (one PDF text line each; the page is 420 pt wide). */
function lines(text: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > 70) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/**
 * The text PDF (about 1.7 KB): each page's lines drawn in Helvetica, with a correct cross-reference
 * table. Objects: 1 catalog, 2 page tree, 3 font, then a page and its content stream per page.
 */
export function textPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${PAGES.map((_, i) => `${String(4 + i * 2)} 0 R`).join(" ")}] /Count ${String(PAGES.length)} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  PAGES.forEach((page, i) => {
    const text = lines(page).map(
      (line) => `(${line.replace(/([\\()])/g, "\\$1")}) Tj T*`,
    );
    const stream = ["BT /F1 9 Tf 12 TL 20 560 Td", ...text, "ET"].join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(5 + i * 2)} 0 R >>`,
      `<< /Length ${String(Buffer.byteLength(stream))} >>\nstream\n${stream}\nendstream`,
    );
  });
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body);
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * An 8-bit greyscale PNG of `width` x `height`: white with a dark "line of text" every 12 rows
 * (about a fifth of the pixels are ink).
 */
export function scannedPagePng(width = 400, height = 240): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(width + 1, 0xff);
    row[0] = 0; // filter: none
    if (y % 12 < 3) row.fill(0x20, 1 + 20, 1 + width - 20);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
