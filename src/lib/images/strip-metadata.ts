// Strips the metadata of a photo without re-encoding it (no decoder, the image data is copied
// byte for byte), so a teacher's photo never carries its GPS position, device or time to storage
// or to an AI provider. Used by every path that accepts a photo: solver finalise
// (solver/service/sessions.ts) and OCR of an image material (materials/service/ocr-job.ts).
// - JPEG: the whole file is walked, scan by scan. Every APPn segment except APP0 (JFIF) and APP14
//   (Adobe, needed to decode some colour transforms) is dropped, with every COM segment, wherever
//   it sits (a progressive file may carry segments between scans): Exif and XMP (APP1), ICC
//   profiles (APP2; colours fall back to sRGB), IPTC/Photoshop (APP13) and maker data. Inside a
//   scan the entropy-coded bytes are copied up to the next real marker (FF00 stuffing and RST0-7
//   stay part of the data). The file ends at the final EOI; anything after it is discarded.
// - PNG: an allow-list. Only IHDR, PLTE, IDAT, IEND, tRNS, gAMA, cHRM, sRGB, bKGD, pHYs and sBIT
//   are kept; everything else is dropped (text, eXIf, tIME, iCCP profiles, APNG animation chunks,
//   which leave the default image, and any unknown or private chunk). Every chunk's CRC must be
//   right, IDAT chunks must form one run, and anything after IEND is discarded.
// When the structure cannot be walked the answer is null and the caller refuses the photo.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_KEPT = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "bKGD",
  "pHYs",
  "sBIT",
]);
const KEPT_APP = new Set([0xe0, 0xee]);

const isRst = (marker: number) => marker >= 0xd0 && marker <= 0xd7;
const isFrame = (marker: number) =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc;

/** The offset of the next real marker after a scan's entropy-coded data starting at `from`. */
function endOfScan(bytes: Uint8Array, from: number): number | null {
  let at = from;
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const next = bytes[at + 1];
    if (next === 0x00 || isRst(next)) {
      at += 2;
      continue;
    }
    if (next === 0xff) {
      // Fill bytes before a marker.
      at += 1;
      continue;
    }
    return at;
  }
  return null;
}

function stripJpeg(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  let frame = false;
  let scans = 0;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9) {
      // The final EOI: the image ends here, whatever follows is discarded.
      if (!frame || scans === 0) return null;
      parts.push(bytes.subarray(offset, offset + 2));
      return concat(parts);
    }
    if (marker === 0x01 || isRst(marker) || marker === 0xd8) return null;
    if (offset + 4 > bytes.length) return null;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) return null;
    if (marker === 0xda) {
      if (!frame) return null;
      const scanEnd = endOfScan(bytes, end);
      if (scanEnd === null) return null;
      parts.push(bytes.subarray(offset, scanEnd));
      scans += 1;
      offset = scanEnd;
      continue;
    }
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if ((!isApp && marker !== 0xfe) || KEPT_APP.has(marker)) {
      parts.push(bytes.subarray(offset, end));
    }
    if (isFrame(marker)) frame = true;
    offset = end;
  }
  return null;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function stripPng(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 8 || PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  let first = true;
  // IDAT chunks must form one run: none, inside the run, or after it.
  let data: "before" | "inside" | "after" = "before";
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4))
      return null;
    if (first && type !== "IHDR") return null;
    first = false;
    if (type === "IDAT") {
      if (data === "after") return null;
      data = "inside";
    } else if (data === "inside") {
      data = "after";
    }
    if (PNG_KEPT.has(type)) parts.push(bytes.subarray(offset, end));
    offset = end;
    // The image ends at IEND: whatever follows is discarded.
    if (type === "IEND") return data === "before" ? null : concat(parts);
  }
  return null;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The image without its metadata, or null when it is not a well-formed file of `mime`. */
export function stripImageMetadata(
  bytes: Uint8Array,
  mime: "image/png" | "image/jpeg",
): Uint8Array | null {
  return mime === "image/png" ? stripPng(bytes) : stripJpeg(bytes);
}
