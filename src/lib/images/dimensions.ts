// Image dimensions read from the header only (no decoding), for the size caps of uploaded logos
// and learning materials.

/** The size a PNG header declares (the IHDR chunk), or null when there is none. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  // The first chunk of a PNG is IHDR: width and height as big-endian 32-bit integers.
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk !== "IHDR") return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The size of a JPEG's first frame header (SOFn), or null when none is found. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  // Walk the marker segments to the first start-of-frame (SOF0..SOF15 except DHT, JPG, DAC).
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
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
      if (offset + 9 > bytes.length) return null;
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}
