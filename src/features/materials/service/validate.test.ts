import { describe, expect, it } from "vitest";
import {
  html,
  lieAboutSizes,
  makeDoc,
  makeDocx,
  makeImage,
  makeMetadataBombPdf,
  makePdf,
  makePngHeader,
  makeZip,
  makeZipBombDocx,
} from "../test-support";
import { MAX_DOCX_ENTRIES, MAX_IMAGE_SIDE, MAX_PDF_PAGES } from "../schema/upload";
import { validateMaterialFile } from "./validate";

const encoder = new TextEncoder();

describe("validateMaterialFile: the bytes decide, never the name", () => {
  it("accepts a PDF and counts its pages", async () => {
    expect(
      await validateMaterialFile(makePdf(3), "pdf", { ownerId: "test-owner" }),
    ).toEqual({
      ok: true,
      data: { kind: "pdf", mime: "application/pdf", pageCount: 3 },
    });
  });

  it(`accepts ${String(MAX_PDF_PAGES)} pages and refuses ${String(MAX_PDF_PAGES + 1)}`, async () => {
    expect(
      await validateMaterialFile(makePdf(MAX_PDF_PAGES), "pdf", {
        ownerId: "test-owner",
      }),
    ).toMatchObject({
      ok: true,
      data: { pageCount: MAX_PDF_PAGES },
    });
    expect(
      await validateMaterialFile(makePdf(MAX_PDF_PAGES + 1), "pdf", {
        ownerId: "test-owner",
      }),
    ).toEqual({
      ok: false,
      error: "pages",
    });
  });

  it("refuses an encrypted PDF", async () => {
    expect(
      await validateMaterialFile(makePdf(1, { encrypt: true }), "pdf", {
        ownerId: "test-owner",
      }),
    ).toEqual({
      ok: false,
      error: "encrypted",
    });
  });

  it("refuses a PDF encrypted with an owner password only", async () => {
    expect(
      await validateMaterialFile(makePdf(1, { encrypt: "ownerOnly" }), "pdf", {
        ownerId: "test-owner",
      }),
    ).toEqual({
      ok: false,
      error: "encrypted",
    });
  });

  it("never inflates a PDF's metadata in this process (memory bomb)", async () => {
    const bomb = makeMetadataBombPdf(1024 * 1024 * 1024);
    // Peak resident memory of this process (KiB); a synchronous inflate blocks any sampler.
    const before = process.resourceUsage().maxRSS;
    const result = await validateMaterialFile(bomb, "pdf", { ownerId: "test-owner" });
    expect(result).toEqual({
      ok: true,
      data: { kind: "pdf", mime: "application/pdf", pageCount: 1 },
    });
    expect(process.resourceUsage().maxRSS - before).toBeLessThan(300 * 1024);
  }, 60_000);

  it("refuses a PDF header followed by garbage as damaged", async () => {
    const bytes = encoder.encode(`%PDF-1.4\n${"x".repeat(200)}`);
    expect(await validateMaterialFile(bytes, "pdf", { ownerId: "test-owner" })).toEqual({
      ok: false,
      error: "damaged",
    });
  });

  it("refuses a .pdf that is really a zip, and a .pdf that is a DOCX", async () => {
    expect(
      await validateMaterialFile(await makeZip(), "pdf", { ownerId: "test-owner" }),
    ).toEqual({
      ok: false,
      error: "type",
    });
    expect(
      await validateMaterialFile(await makeDocx(), "pdf", { ownerId: "test-owner" }),
    ).toEqual({
      ok: false,
      error: "type",
    });
  });

  it("refuses a .png that is HTML", async () => {
    expect(await validateMaterialFile(html(), "png", { ownerId: "test-owner" })).toEqual({
      ok: false,
      error: "type",
    });
  });

  it("refuses an old Word .doc with its own reason, whatever it was named", async () => {
    expect(
      await validateMaterialFile(makeDoc(), "docx", { ownerId: "test-owner" }),
    ).toEqual({
      ok: false,
      error: "doc",
    });
    expect(
      await validateMaterialFile(makeDoc(), "pdf", { ownerId: "test-owner" }),
    ).toEqual({
      ok: false,
      error: "doc",
    });
  });

  it("accepts a DOCX (page count left to ingestion)", async () => {
    expect(
      await validateMaterialFile(await makeDocx(), "docx", { ownerId: "test-owner" }),
    ).toEqual({
      ok: true,
      data: {
        kind: "docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        pageCount: null,
      },
    });
  });

  it("refuses a zip that is not a Word document as a .docx", async () => {
    expect(
      await validateMaterialFile(await makeZip(), "docx", { ownerId: "test-owner" }),
    ).toEqual({
      ok: false,
      error: "type",
    });
  });

  it("refuses a DOCX that inflates past 20 times its size", async () => {
    const bomb = await makeZipBombDocx(5_000_000);
    expect(bomb.length * 20).toBeLessThan(5_000_000);
    expect(await validateMaterialFile(bomb, "docx", { ownerId: "test-owner" })).toEqual({
      ok: false,
      error: "zipBomb",
    });
  });

  it("refuses a zip bomb whose headers lie about the uncompressed sizes", async () => {
    const liar = lieAboutSizes(await makeZipBombDocx(5_000_000), 100);
    expect(await validateMaterialFile(liar, "docx", { ownerId: "test-owner" })).toEqual({
      ok: false,
      error: "zipBomb",
    });
  });

  it(`refuses a DOCX with more than ${String(MAX_DOCX_ENTRIES)} entries`, async () => {
    const extra = Object.fromEntries(
      Array.from({ length: MAX_DOCX_ENTRIES }, (_, i) => [
        `word/media/p${String(i)}.xml`,
        "x",
      ]),
    );
    expect(
      await validateMaterialFile(await makeDocx({ extra }), "docx", {
        ownerId: "test-owner",
      }),
    ).toEqual({
      ok: false,
      error: "zipBomb",
    });
  });

  it("accepts a PNG and a JPEG as one page each", async () => {
    expect(
      await validateMaterialFile(makeImage("png"), "png", { ownerId: "test-owner" }),
    ).toEqual({
      ok: true,
      data: { kind: "image", mime: "image/png", pageCount: 1 },
    });
    expect(
      await validateMaterialFile(makeImage("jpeg"), "jpg", { ownerId: "test-owner" }),
    ).toEqual({
      ok: true,
      data: { kind: "image", mime: "image/jpeg", pageCount: 1 },
    });
  });

  it("refuses a JPEG named .png (the stored key would lie about it)", async () => {
    expect(
      await validateMaterialFile(makeImage("jpeg"), "png", { ownerId: "test-owner" }),
    ).toEqual({
      ok: false,
      error: "type",
    });
  });

  it("refuses an image whose header is unreadable or too large", async () => {
    expect(
      await validateMaterialFile(makePngHeader(MAX_IMAGE_SIDE + 1, 10), "png", {
        ownerId: "test-owner",
      }),
    ).toEqual({ ok: false, error: "image" });
    expect(
      await validateMaterialFile(makePngHeader(0, 10), "png", { ownerId: "test-owner" }),
    ).toEqual({
      ok: false,
      error: "image",
    });
    const truncatedJpeg = makeImage("jpeg").slice(0, 4);
    expect(
      await validateMaterialFile(truncatedJpeg, "jpg", { ownerId: "test-owner" }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("refuses an empty file", async () => {
    expect(
      await validateMaterialFile(new Uint8Array(), "pdf", { ownerId: "test-owner" }),
    ).toEqual({
      ok: false,
      error: "type",
    });
  });
});
