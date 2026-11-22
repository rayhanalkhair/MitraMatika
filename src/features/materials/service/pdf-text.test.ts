import { describe, expect, it } from "vitest";
import { lines, makeScannedPdf, makeTextPdf, PROSE } from "../fixtures/ingest";
import { makePdf } from "../test-support";
import { MAX_PDF_PAGES } from "../schema/upload";
import { MAX_PAGE_CHARS } from "./page-quality";
import { extractPdfText } from "./pdf-text";

const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const numbered = (count: number) =>
  makeTextPdf(Array.from({ length: count }, (_, i) => [`Halaman ${String(i + 1)}`]));

describe("extractPdfText (in the bounded worker)", () => {
  it("reads the text layer of each page in the range", async () => {
    const pdf = makeTextPdf([lines(PROSE), ["Latihan 1", "Tentukan suku ke-10."]]);
    const result = await extractPdfText(pdf, { ownerId: "test-owner", from: 1, to: 25 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.pages).toBe(2);
    expect(result.texts.map(flat)).toEqual([PROSE, "Latihan 1 Tentukan suku ke-10."]);
  });

  it("reads only the pages asked for and stops at the last page", async () => {
    const pdf = numbered(5);
    expect(
      await extractPdfText(pdf, { ownerId: "test-owner", from: 2, to: 3 }),
    ).toMatchObject({
      status: "ok",
      pages: 5,
      texts: ["Halaman 2", "Halaman 3"],
    });
    const tail = await extractPdfText(pdf, { ownerId: "test-owner", from: 4, to: 28 });
    expect(tail.status === "ok" && tail.texts.map(flat)).toEqual([
      "Halaman 4",
      "Halaman 5",
    ]);
    const past = await extractPdfText(pdf, { ownerId: "test-owner", from: 6, to: 30 });
    expect(past).toEqual({ status: "ok", pages: 5, texts: [] });
  });

  it(`never reads past page ${String(MAX_PDF_PAGES)}, whatever the range`, async () => {
    const result = await extractPdfText(numbered(MAX_PDF_PAGES + 5), {
      ownerId: "test-owner",
      from: 296,
      to: 320,
    });
    expect(result.status === "ok" && result.texts.map(flat)).toEqual(
      [296, 297, 298, 299, 300].map((n) => `Halaman ${String(n)}`),
    );
  });

  it("gives an empty text for a scanned page (no text layer)", async () => {
    expect(
      await extractPdfText(makeScannedPdf(), { ownerId: "test-owner", from: 1, to: 25 }),
    ).toEqual({
      status: "ok",
      pages: 1,
      texts: [""],
    });
  });

  it(`cuts a page's text at ${String(MAX_PAGE_CHARS)} characters inside the worker`, async () => {
    // 40 lines of 600 characters on a page wide enough to hold them.
    const long = Array.from({ length: 40 }, () => "x".repeat(600));
    const result = await extractPdfText(makeTextPdf([long], { width: 4000 }), {
      ownerId: "test-owner",
      from: 1,
      to: 1,
    });
    expect(result.status === "ok" && result.texts[0].length).toBe(MAX_PAGE_CHARS);
  });

  it("reports damaged, encrypted and timed-out files", async () => {
    const garbage = new TextEncoder().encode(`%PDF-1.4\n${"x".repeat(200)}`);
    expect(
      await extractPdfText(garbage, { ownerId: "test-owner", from: 1, to: 25 }),
    ).toEqual({
      status: "damaged",
    });
    expect(
      await extractPdfText(makePdf(1, { encrypt: true }), {
        ownerId: "test-owner",
        from: 1,
        to: 25,
      }),
    ).toEqual({
      status: "encrypted",
    });
    expect(
      await extractPdfText(makePdf(1, { encrypt: "ownerOnly" }), {
        ownerId: "test-owner",
        from: 1,
        to: 25,
      }),
    ).toEqual({ status: "encrypted" });
    expect(
      await extractPdfText(numbered(3), {
        ownerId: "test-owner",
        from: 1,
        to: 3,
        timeoutMs: 1,
      }),
    ).toEqual({
      status: "damaged",
    });
  });

  it("refuses a range that does not start at a page", async () => {
    await expect(
      extractPdfText(numbered(1), { ownerId: "test-owner", from: 0, to: 3 }),
    ).rejects.toThrow(RangeError);
    await expect(
      extractPdfText(numbered(1), { ownerId: "test-owner", from: 3, to: 2 }),
    ).rejects.toThrow(RangeError);
  });
});
