// Test helpers: material files generated in the test, so no binary fixture is checked in. Each one
// is the smallest file that shows one rule of decision 1.
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";
import JSZip from "jszip";

const encoder = new TextEncoder();

/**
 * A valid PDF of `pages` empty pages with a correct cross-reference table. With `encrypt: true`
 * the trailer names a Standard security handler whose /U does not match the empty user password,
 * so a reader must ask for a password. With `encrypt: "ownerOnly"` the /U is right for the empty
 * user password (RC4, revision 2): it opens without a password but is still encrypted.
 */
export function makePdf(
  pages: number,
  options: { encrypt?: boolean | "ownerOnly" } = {},
): Uint8Array {
  const objects: string[] = [];
  const pageIds = Array.from({ length: pages }, (_, i) => i + 3);
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(" ")}] /Count ${String(pages)} >>`,
  );
  for (let i = 0; i < pages; i += 1) {
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>");
  }
  const hex32 = (byte: string) => `<${byte.repeat(32)}>`;
  let encryptRef = "";
  if (options.encrypt) {
    const u =
      options.encrypt === "ownerOnly"
        ? `<${emptyPasswordU("ab".repeat(32))}>`
        : hex32("cd");
    objects.push(`<< /Filter /Standard /V 1 /R 2 /O ${hex32("ab")} /U ${u} /P -4 >>`);
    const id = `<${PDF_ID}>`;
    encryptRef = ` /Encrypt ${String(objects.length)} 0 R /ID [${id} ${id}]`;
  }

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(body).length);
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = encoder.encode(body).length;
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R${encryptRef} >>\nstartxref\n${String(xrefAt)}\n%%EOF\n`;
  return encoder.encode(body);
}

const PDF_ID = "0123456789abcdef0123456789abcdef";
const PASSWORD_PAD = "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a";

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const state = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + state[i] + key[i % key.length]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let n = 0; n < data.length; n += 1) {
    a = (a + 1) & 0xff;
    b = (b + state[a]) & 0xff;
    [state[a], state[b]] = [state[b], state[a]];
    out[n] = data[n] ^ state[(state[a] + state[b]) & 0xff];
  }
  return out;
}

/** /U of the Standard handler, revision 2, for the empty user password (hex). */
function emptyPasswordU(ownerHex: string): string {
  const p = Buffer.alloc(4);
  p.writeInt32LE(-4);
  const key = createHash("md5")
    .update(Buffer.from(PASSWORD_PAD, "hex"))
    .update(Buffer.from(ownerHex, "hex"))
    .update(p)
    .update(Buffer.from(PDF_ID, "hex"))
    .digest()
    .subarray(0, 5);
  return Buffer.from(rc4(key, Buffer.from(PASSWORD_PAD, "hex"))).toString("hex");
}

/**
 * A one-page PDF whose catalog points at an XMP /Metadata stream that inflates to `inflated`
 * bytes (the review's memory bomb: pdf.js inflates it without a limit when metadata is read).
 */
export function makeMetadataBombPdf(inflated: number): Uint8Array {
  const packed = deflateSync(Buffer.alloc(inflated, 0x20), { level: 9 });
  const head = Buffer.from("%PDF-1.4\n");
  const chunks: Buffer[] = [head];
  const offsets: number[] = [];
  let length = head.length;
  const add = (chunk: Buffer) => {
    offsets.push(length);
    chunks.push(chunk);
    length += chunk.length;
  };
  add(
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Metadata 4 0 R >>\nendobj\n"),
  );
  add(Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"));
  add(
    Buffer.from(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n",
    ),
  );
  add(
    Buffer.concat([
      Buffer.from(
        `4 0 obj\n<< /Type /Metadata /Subtype /XML /Filter /FlateDecode /Length ${String(packed.length)} >>\nstream\n`,
      ),
      packed,
      Buffer.from("\nendstream\nendobj\n"),
    ]),
  );
  const xref = [
    "xref\n0 5\n0000000000 65535 f \n",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${String(length)}\n%%EOF\n`,
  ].join("");
  return new Uint8Array(Buffer.concat([...chunks, Buffer.from(xref)]));
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const document = (text: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;

/** A minimal DOCX; `extra` adds entries (name -> content). */
export async function makeDocx(
  options: { text?: string; extra?: Record<string, string> } = {},
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", RELS);
  zip.file("word/document.xml", document(options.text ?? "Bab 1 Pola bilangan"));
  for (const [name, content] of Object.entries(options.extra ?? {}))
    zip.file(name, content);
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

/** A DOCX whose document part inflates to `bytes` of one repeated letter (a zip bomb). */
export function makeZipBombDocx(bytes: number): Promise<Uint8Array> {
  return makeDocx({ text: "a".repeat(bytes) });
}

/**
 * Rewrites every uncompressed-size field (local headers and the central directory) to `size`, so
 * the archive LIES about how large its entries are. Only inflating shows the truth.
 */
export function lieAboutSizes(zip: Uint8Array, size: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let i = 0; i + 4 <= out.length; i += 1) {
    const signature = view.getUint32(i, true);
    if (signature === 0x04034b50) view.setUint32(i + 22, size, true);
    if (signature === 0x02014b50) view.setUint32(i + 24, size, true);
  }
  return out;
}

/** A plain zip (no Office parts): what a ".pdf" that is really an archive looks like. */
export function makeZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("readme.txt", "bukan pdf");
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** An old Word .doc: an OLE compound file header followed by padding. */
export function makeDoc(): Uint8Array {
  const bytes = new Uint8Array(1024);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  return bytes;
}

export function makeImage(format: "png" | "jpeg", width = 8, height = 8): Uint8Array {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#3730a3";
  context.fillRect(0, 0, width, height);
  return new Uint8Array(
    format === "png" ? canvas.encodeSync("png") : canvas.encodeSync("jpeg"),
  );
}

/** A PNG whose header claims `width` x `height` (only the first chunk matters for the check). */
export function makePngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set(encoder.encode("IHDR"), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

export const html = (): Uint8Array =>
  encoder.encode("<!doctype html><html><body><script>alert(1)</script></body></html>");
