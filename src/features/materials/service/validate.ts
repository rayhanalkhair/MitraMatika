import "server-only";
import { createInflateRaw } from "node:zlib";
import { fileTypeFromBuffer } from "file-type";
import { jpegSize, pngSize } from "@/lib/images/dimensions";
import { err, ok, type Result } from "@/lib/result";
import {
  DOCX_INFLATE_RATIO,
  MATERIAL_TYPES,
  MAX_DOCX_ENTRIES,
  MAX_DOCX_INFLATED_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  MAX_PDF_PAGES,
  type FileValidationError,
  type MaterialExt,
  type MaterialKind,
} from "../schema/upload";
import { inspectPdf } from "./pdf-worker";

// What an uploaded material IS comes from its bytes (magic numbers via file-type, then a check of
// the format itself), never from its name or the type the browser declared. The upload's
// extension (fixed when the URL was signed, part of the object key) must agree with the bytes.

export interface ValidMaterial {
  kind: MaterialKind;
  mime: string;
  /** Pages of a PDF, 1 for an image; a DOCX is counted by ingestion. */
  pageCount: number | null;
}

type Validation = Result<ValidMaterial, FileValidationError | "busy">;

const valid = (ext: MaterialExt, pageCount: number | null): Validation =>
  ok({ ...MATERIAL_TYPES[ext], pageCount });

export async function validateMaterialFile(
  bytes: Uint8Array,
  ext: MaterialExt,
  options: { ownerId: string; parseWaitMs?: number },
): Promise<Validation> {
  if (bytes.length === 0) return err("type");
  const detected = (await fileTypeFromBuffer(bytes))?.ext;
  // An old Word document (OLE compound file), whatever it was named: "save it as .docx".
  if (detected === "cfb") return err("doc");

  switch (ext) {
    case "pdf":
      return detected === "pdf"
        ? validatePdf(bytes, options.ownerId, options.parseWaitMs)
        : err("type");
    case "docx":
      // file-type names a Word archive "docx" only when its parts are where it looks; the zip
      // check below decides either way.
      return detected === "docx" || detected === "zip"
        ? validateDocx(bytes)
        : err("type");
    case "png":
    case "jpg":
      return detected === ext ? validateImage(bytes, ext) : err("type");
  }
}

/** Ruling R10: parsed in a bounded worker (pdf-worker.ts); a crash or timeout is damaged. */
async function validatePdf(
  bytes: Uint8Array,
  ownerId: string,
  waitMs?: number,
): Promise<Validation> {
  const inspection = await inspectPdf(bytes, { ownerId, waitMs });
  if (inspection.status !== "ok") return err(inspection.status);
  if (inspection.pages < 1) return err("damaged");
  if (inspection.pages > MAX_PDF_PAGES) return err("pages");
  return valid("pdf", inspection.pages);
}

function validateImage(bytes: Uint8Array, ext: "png" | "jpg"): Validation {
  let size: { width: number; height: number } | null;
  try {
    size = ext === "png" ? pngSize(bytes) : jpegSize(bytes);
  } catch {
    // A segment length that points past the end of the file.
    size = null;
  }
  if (!size || size.width === 0 || size.height === 0) return err("image");
  if (
    size.width > MAX_IMAGE_SIDE ||
    size.height > MAX_IMAGE_SIDE ||
    size.width * size.height > MAX_IMAGE_PIXELS
  ) {
    return err("image");
  }
  return valid(ext, 1);
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/**
 * Reads the central directory of a zip without inflating anything. Null when the archive is not
 * a plain (non-ZIP64, single-disk) zip whose directory lies inside the file.
 */
function readCentralDirectory(
  bytes: Uint8Array,
): { entries: ZipEntry[]; declaredTotal: number } | "tooMany" | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is in the last 22 + 65,535 (comment) bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  // 0xffff / 0xffffffff mean ZIP64, which no Word document of this size needs.
  if (count === 0xffff || directoryOffset === 0xffffffff) return null;
  if (count > MAX_DOCX_ENTRIES) return "tooMany";

  const entries: ZipEntry[] = [];
  let declaredTotal = 0;
  let offset = directoryOffset;
  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      return null;
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (offset + 46 + nameLength > bytes.length) return null;
    entries.push({
      name: new TextDecoder().decode(
        bytes.subarray(offset + 46, offset + 46 + nameLength),
      ),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    });
    declaredTotal += view.getUint32(offset + 24, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, declaredTotal };
}

/** Where an entry's compressed data starts and ends, from its local header. */
function entryData(bytes: Uint8Array, entry: ZipEntry): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localHeaderOffset;
  if (at + 30 > bytes.length || view.getUint32(at, true) !== 0x04034b50) return null;
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const end = start + entry.compressedSize;
  return end <= bytes.length ? bytes.subarray(start, end) : null;
}

/**
 * Inflates one deflated entry as a stream, counting the output and discarding it, and stops as
 * soon as it passes `budget`. Returns the inflated size, or null past the budget. Memory stays at
 * one zlib chunk whatever the entry claims or holds.
 */
function inflatedSize(data: Uint8Array, budget: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const inflater = createInflateRaw();
    let total = 0;
    let settled = false;
    inflater.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > budget && !settled) {
        settled = true;
        inflater.destroy();
        resolve(null);
      }
    });
    inflater.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(total);
      }
    });
    inflater.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    inflater.end(data);
  });
}

/**
 * A DOCX is a zip: at most MAX_DOCX_ENTRIES entries, inflating in all to at most 20 times the
 * file and 200 MB. The sizes the archive declares are a first, cheap check only (they can lie);
 * every entry is then really inflated, counted and thrown away. It must hold the two parts every
 * Word document has.
 */
async function validateDocx(bytes: Uint8Array): Promise<Validation> {
  const directory = readCentralDirectory(bytes);
  if (directory === "tooMany") return err("zipBomb");
  if (!directory) return err("damaged");
  const limit = Math.min(bytes.length * DOCX_INFLATE_RATIO, MAX_DOCX_INFLATED_BYTES);
  if (directory.declaredTotal > limit) return err("zipBomb");

  let remaining = limit;
  for (const entry of directory.entries) {
    const data = entryData(bytes, entry);
    if (!data) return err("damaged");
    let size: number | null;
    if (entry.method === 0) {
      size = data.length <= remaining ? data.length : null;
    } else if (entry.method === 8) {
      try {
        size = await inflatedSize(data, remaining);
      } catch {
        return err("damaged");
      }
    } else {
      return err("damaged");
    }
    if (size === null) return err("zipBomb");
    remaining -= size;
  }

  const names = new Set(directory.entries.map((entry) => entry.name));
  if (!names.has("[Content_Types].xml") || !names.has("word/document.xml")) {
    return err("type");
  }
  return valid("docx", null);
}
