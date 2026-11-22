// Pixel size of a PNG or JPEG from its header, shared by the Word and PDF logo code. A malformed
// or truncated image gives null: the caller leaves the logo out.

/** Width and height in pixels, or null when the bytes are not a readable PNG / JPEG header. */
export function imageSize(
  bytes: Uint8Array,
  type: "png" | "jpg",
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
    if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;
    const size = { width: view.getUint32(16), height: view.getUint32(20) };
    return size.width > 0 && size.height > 0 ? size : null;
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    const length = view.getUint16(offset + 2);
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame) {
      const size = {
        width: view.getUint16(offset + 7),
        height: view.getUint16(offset + 5),
      };
      return size.width > 0 && size.height > 0 ? size : null;
    }
    offset += 2 + length;
  }
  return null;
}
