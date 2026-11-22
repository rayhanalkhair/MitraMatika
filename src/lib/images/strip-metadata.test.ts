import { loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import {
  contains,
  image,
  jpegWithExif,
  jpegWithLateMetadata,
  jpegWithTwoScans,
  pngWithBadCrc,
  pngWithMetadata,
  pngWithPrivateChunks,
  pngWithSplitData,
  text,
} from "./metadata-fixtures";
import { stripImageMetadata } from "./strip-metadata";

describe("stripImageMetadata", () => {
  it("drops Exif (GPS), XMP, IPTC and comments from a JPEG without re-encoding it", async () => {
    const original = jpegWithExif();
    expect(contains(original, "GPSLatitude")).toBe(true);
    const clean = stripImageMetadata(original, "image/jpeg");
    expect(clean).not.toBeNull();
    if (!clean) return;
    for (const marker of ["Exif", "GPS", "xmpmeta", "8BIM", "rumah"]) {
      expect(contains(clean, marker), marker).toBe(false);
    }
    // The image data itself is untouched and still decodes.
    const plain = image("jpeg");
    expect(
      Buffer.from(clean.subarray(-200)).equals(Buffer.from(plain.subarray(-200))),
    ).toBe(true);
    const decoded = await loadImage(Buffer.from(clean));
    expect([decoded.width, decoded.height]).toEqual([12, 8]);
  });

  it("drops eXIf, tEXt, iTXt, zTXt and tIME from a PNG and keeps it decodable", async () => {
    const original = pngWithMetadata();
    const clean = stripImageMetadata(original, "image/png");
    expect(clean).not.toBeNull();
    if (!clean) return;
    for (const marker of ["eXIf", "tEXt", "iTXt", "zTXt", "tIME", "GPS", "rumah"]) {
      expect(contains(clean, marker), marker).toBe(false);
    }
    expect(Buffer.from(clean).equals(Buffer.from(image("png")))).toBe(true);
    const decoded = await loadImage(Buffer.from(clean));
    expect([decoded.width, decoded.height]).toEqual([12, 8]);
  });

  it("refuses bytes that are not a well-formed image of the type", () => {
    expect(stripImageMetadata(text("<html>"), "image/jpeg")).toBeNull();
    expect(stripImageMetadata(image("png"), "image/jpeg")).toBeNull();
    expect(stripImageMetadata(image("jpeg").subarray(0, 40), "image/jpeg")).toBeNull();
    expect(stripImageMetadata(image("png").subarray(0, 40), "image/png")).toBeNull();
  });

  it("walks every scan of a JPEG: drops segments after the first scan and bytes after EOI", async () => {
    const late = stripImageMetadata(jpegWithLateMetadata(), "image/jpeg");
    expect(late).not.toBeNull();
    if (!late) return;
    for (const marker of ["Exif", "GPS", "rumah", "trailing"]) {
      expect(contains(late, marker), marker).toBe(false);
    }
    // The same bytes as the plain photo after the same stripping (its own APPn go too).
    const plain = stripImageMetadata(image("jpeg"), "image/jpeg");
    expect(plain && Buffer.from(late).equals(Buffer.from(plain))).toBe(true);
    const decoded = await loadImage(Buffer.from(late));
    expect([decoded.width, decoded.height]).toEqual([12, 8]);

    // Stuffed FF00 bytes and RST markers stay inside their scan; the APP1 between scans goes.
    const { input, expected } = jpegWithTwoScans();
    const walked = stripImageMetadata(input, "image/jpeg");
    expect(walked && Buffer.from(walked).equals(Buffer.from(expected))).toBe(true);
  });

  it("refuses a JPEG whose scans never reach EOI", () => {
    const { input } = jpegWithTwoScans();
    const end = Buffer.from(input).lastIndexOf(Buffer.from([0xff, 0xd9]));
    expect(stripImageMetadata(input.subarray(0, end), "image/jpeg")).toBeNull();
  });

  it("keeps only the PNG chunks needed to show the image, and nothing after IEND", async () => {
    const clean = stripImageMetadata(pngWithPrivateChunks(), "image/png");
    expect(clean).not.toBeNull();
    if (!clean) return;
    for (const marker of ["iCCP", "prVt", "GPS", "rumah", "trailing"]) {
      expect(contains(clean, marker), marker).toBe(false);
    }
    expect(Buffer.from(clean).equals(Buffer.from(image("png")))).toBe(true);
    const decoded = await loadImage(Buffer.from(clean));
    expect([decoded.width, decoded.height]).toEqual([12, 8]);
  });

  it("refuses a PNG with a broken CRC or image data split by another chunk", () => {
    expect(stripImageMetadata(pngWithBadCrc(), "image/png")).toBeNull();
    expect(stripImageMetadata(pngWithSplitData(), "image/png")).toBeNull();
  });
});
