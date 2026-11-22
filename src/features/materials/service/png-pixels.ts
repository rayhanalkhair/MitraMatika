import "server-only";
// The pixels of a page PNG the browser rendered (8-bit grey, grey+alpha, RGB or RGBA, not
// interlaced: what a canvas produces), as RGBA, for the blank-page check. The inflated size is
// bounded by the header's own dimensions (checked against MAX_PAGE_IMAGE_SIDE first), so a
// compression bomb cannot grow past width x height. Anything else is null.
import { inflateSync } from "node:zlib";

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function pngRgba(
  bytes: Uint8Array,
): { width: number; height: number; rgba: Uint8Array } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Uint8Array[] = [];
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = offset + 8;
    if (body + length + 4 > bytes.length) return null;
    if (type === "IHDR") {
      width = view.getUint32(body);
      height = view.getUint32(body + 4);
      const depth = bytes[body + 8];
      const kind = bytes[body + 9];
      const interlace = bytes[body + 12];
      channels = CHANNELS[kind] ?? 0;
      if (depth !== 8 || channels === 0 || interlace !== 0) return null;
    } else if (type === "IDAT") {
      data.push(bytes.subarray(body, body + length));
    } else if (type === "IEND") {
      break;
    }
    offset = body + length + 4;
  }
  if (width < 1 || height < 1 || channels === 0 || data.length === 0) return null;
  const stride = width * channels;
  const expected = height * (stride + 1);
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
  } catch {
    return null;
  }
  if (raw.length !== expected) return null;

  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  let line = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[start + 1 + x];
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let out: number;
      if (filter === 0) out = value;
      else if (filter === 1) out = value + left;
      else if (filter === 2) out = value + up;
      else if (filter === 3) out = value + ((left + up) >> 1);
      else if (filter === 4) out = value + paeth(left, up, upLeft);
      else return null;
      line[x] = out & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      if (channels <= 2) {
        rgba[to] = rgba[to + 1] = rgba[to + 2] = line[from];
        rgba[to + 3] = channels === 2 ? line[from + 1] : 255;
      } else {
        rgba[to] = line[from];
        rgba[to + 1] = line[from + 1];
        rgba[to + 2] = line[from + 2];
        rgba[to + 3] = channels === 4 ? line[from + 3] : 255;
      }
    }
    [previous, line] = [line, previous];
  }
  return { width, height, rgba };
}
