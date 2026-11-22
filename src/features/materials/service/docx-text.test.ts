import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  makeDocxBody,
  makeEquationDocx,
  makeLargeDocx,
  makeNestedDocx,
  para,
  PROSE,
  W_NS,
  M_NS,
} from "../fixtures/ingest";
import { makeZipBombDocx } from "../test-support";
import { MAX_PDF_PAGES } from "../schema/upload";
import {
  DOCX_PAGE_CHARS,
  DOCX_WORKER_LIMITS,
  DOCX_WORKER_TIMEOUT_MS,
  extractDocxPages,
  MAX_DOCX_XML_BYTES,
  MAX_DOCX_XML_DEPTH,
} from "./docx-text";
import { pageQuality } from "./page-quality";

async function pages(bytes: Uint8Array | Promise<Uint8Array>): Promise<string[]> {
  const result = await extractDocxPages(await bytes, { ownerId: "test-owner" });
  if (!result.ok) throw new Error(`extractDocxPages: ${result.error}`);
  return result.data.pages;
}

/**
 * Runs `work` while a 10 ms timer measures this thread's event loop: the largest gap between
 * ticks shows whether the main thread stayed responsive.
 */
async function withLoopWatch<T>(work: () => Promise<T>) {
  let last = performance.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  const started = performance.now();
  try {
    const value = await work();
    return { value, ms: performance.now() - started, maxGap };
  } finally {
    clearInterval(timer);
  }
}

describe("extractDocxPages", () => {
  it("keeps the text and turns the supported equations into LaTeX in place", async () => {
    const [page, ...rest] = await pages(makeEquationDocx());
    expect(rest).toEqual([]);
    expect(page).toContain(PROSE);
    expect(page).toContain(
      "Pecahan $\\frac{a}{b}$ dan akar $\\sqrt{x}$ serta pangkat $x^{2}+1$",
    );
    expect(page).toContain("$$\\left(a+b\\right)^{2}$$");
  });

  it("marks an equation it cannot convert with [[?]] around its plain text, so the page is flagged", async () => {
    const [page] = await pages(makeEquationDocx());
    expect(page).toContain("Matriks [[?]]1 2[[?]]");
    expect(pageQuality(page)).toEqual({
      confidence: "medium",
      flags: ["uncertain_math"],
    });
  });

  it("starts a new page at an explicit page break or a paragraph that breaks before", async () => {
    const result = await pages(
      makeDocxBody(
        [
          para("Halaman satu."),
          '<w:p><w:r><w:t>Akhir satu.</w:t><w:br w:type="page"/><w:t>Awal dua.</w:t></w:r></w:p>',
          "<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Halaman tiga.</w:t></w:r></w:p>",
          '<w:p><w:pPr><w:pageBreakBefore w:val="0"/></w:pPr><w:r><w:t>Masih tiga.</w:t></w:r></w:p>',
        ].join(""),
      ),
    );
    expect(result).toEqual([
      "Halaman satu.\n\nAkhir satu.",
      "Awal dua.",
      "Halaman tiga.\n\nMasih tiga.",
    ]);
  });

  it(`without page breaks, cuts pages of at most ${String(DOCX_PAGE_CHARS)} characters between paragraphs`, async () => {
    const result = await pages(
      makeDocxBody(Array.from({ length: 24 }, () => para(PROSE)).join("")),
    );
    expect(result.length).toBeGreaterThan(1);
    for (const page of result) {
      expect(page.length).toBeLessThanOrEqual(DOCX_PAGE_CHARS);
      // Whole paragraphs only.
      for (const paragraph of page.split("\n\n")) expect(paragraph).toBe(PROSE);
    }
    expect(result.join("\n\n").split("\n\n")).toHaveLength(24);
  });

  it("cuts a paragraph longer than a page between words, never inside an equation", async () => {
    const words = Array.from({ length: 700 }, (_, i) => `kata${String(i)}`).join(" ");
    const equation = `<m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath>`;
    const body = `<w:p><w:r><w:t xml:space="preserve">${words} </w:t></w:r>${equation}<w:r><w:t xml:space="preserve"> ${words}</w:t></w:r></w:p>`;
    const result = await pages(makeDocxBody(body));
    expect(result.length).toBeGreaterThan(2);
    for (const page of result) {
      expect(page.length).toBeLessThanOrEqual(DOCX_PAGE_CHARS);
      expect((page.match(/\$/g) ?? []).length % 2).toBe(0);
      expect(page).not.toMatch(/^\s|\s$/);
    }
    expect(result.join(" ")).toContain("$\\frac{1}{2}$");
  });

  it("keeps line breaks and tabs, and leaves out deleted text", async () => {
    const [page] = await pages(
      makeDocxBody(
        "<w:p><w:r><w:t>Baris satu</w:t><w:br/><w:t>baris dua</w:t><w:tab/><w:t>kolom</w:t></w:r><w:del><w:r><w:delText>hapus</w:delText></w:r></w:del></w:p>",
      ),
    );
    expect(page).toBe("Baris satu\nbaris dua\tkolom");
  });

  it("drops empty pages but always returns at least one page", async () => {
    expect(await pages(makeDocxBody(""))).toEqual([""]);
    expect(
      await pages(
        makeDocxBody(
          `${para("A")}<w:p><w:r><w:br w:type="page"/><w:br w:type="page"/></w:r></w:p>${para("B")}`,
        ),
      ),
    ).toEqual(["A", "B"]);
  });

  it(`stops at ${String(MAX_PDF_PAGES)} pages and says the rest was cut`, async () => {
    const breaks = Array.from(
      { length: MAX_PDF_PAGES + 20 },
      (_, i) =>
        `<w:p><w:r><w:t>Hal ${String(i + 1)}</w:t><w:br w:type="page"/></w:r></w:p>`,
    ).join("");
    const result = await extractDocxPages(await makeDocxBody(breaks), {
      ownerId: "test-owner",
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.data.pages).toHaveLength(MAX_PDF_PAGES);
    expect(result.data.pages.at(-1)).toBe(`Hal ${String(MAX_PDF_PAGES)}`);
    expect(result.data.truncated).toBe(true);
    const short = await extractDocxPages(await makeEquationDocx(), {
      ownerId: "test-owner",
    });
    expect(short.ok && short.data.truncated).toBe(false);
  });

  it("never cuts inside an equation, even where a page must be cut hard", async () => {
    // One "word" of 2,995 letters, an equation across the 3,000th character, then more letters.
    const body = `<w:p><w:r><w:t>${"x".repeat(2995)}</w:t></w:r><m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath><w:r><w:t>${"y".repeat(400)}</w:t></w:r></w:p>`;
    const result = await pages(makeDocxBody(body));
    expect(result.length).toBeGreaterThan(1);
    for (const page of result) expect((page.match(/\$/g) ?? []).length % 2).toBe(0);
    expect(result).toContain("x".repeat(2995));
    expect(result.join("")).toContain("$\\frac{1}{2}$");
  });

  it("cannot be tricked by text that looks like its own placeholders", async () => {
    const [page] = await pages(makeDocxBody(para("MMEQ0X0X dan MMPB0 dan $x$")));
    expect(page).toBe("MMEQ0X0X dan MMPB0 dan $x$");
  });

  it("reads in a bounded worker (heap limit, 30 s timeout) with a 4 MB part and depth 256", () => {
    expect(DOCX_WORKER_LIMITS).toEqual({
      maxOldGenerationSizeMb: 768,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    });
    expect(DOCX_WORKER_TIMEOUT_MS).toBe(30_000);
    expect(MAX_DOCX_XML_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_DOCX_XML_DEPTH).toBe(256);
  });

  it("refuses 50,000 nested content controls quickly, with the main thread responsive", async () => {
    const nested = await makeNestedDocx(50_000);
    expect(nested.length).toBeLessThan(400 * 1024);
    const run = await withLoopWatch(() =>
      extractDocxPages(nested, { ownerId: "test-owner" }),
    );
    expect(run.value).toEqual({ ok: false, error: "damaged" });
    expect(run.ms).toBeLessThan(10_000);
    expect(run.maxGap).toBeLessThan(500);
  }, 60_000);

  it("refuses a document part over 4 MB without reading it, the main thread responsive", async () => {
    const large = await makeLargeDocx(MAX_DOCX_XML_BYTES + 256 * 1024);
    const run = await withLoopWatch(() =>
      extractDocxPages(large, { ownerId: "test-owner" }),
    );
    expect(run.value).toEqual({ ok: false, error: "tooLarge" });
    expect(run.ms).toBeLessThan(10_000);
    expect(run.maxGap).toBeLessThan(500);
  }, 60_000);

  it("reads a large part under the cap in the worker while the main thread stays responsive", async () => {
    const big = await makeLargeDocx(3 * 1024 * 1024);
    const run = await withLoopWatch(() =>
      extractDocxPages(big, { ownerId: "test-owner" }),
    );
    expect(run.value.ok).toBe(true);
    expect(run.maxGap).toBeLessThan(500);
  }, 60_000);

  it("maps a worker that runs out of heap or time to damaged, and this process lives on", async () => {
    const big = await makeLargeDocx(1024 * 1024);
    expect(
      await extractDocxPages(big, {
        ownerId: "test-owner",
        resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
      }),
    ).toEqual({ ok: false, error: "damaged" });
    expect(
      await extractDocxPages(await makeEquationDocx(), {
        ownerId: "test-owner",
        timeoutMs: 1,
      }),
    ).toEqual({
      ok: false,
      error: "damaged",
    });
  }, 60_000);

  it("re-applies the zip limits of finalise (zip bomb)", async () => {
    expect(
      await extractDocxPages(await makeZipBombDocx(5 * 1024 * 1024), {
        ownerId: "test-owner",
      }),
    ).toEqual({
      ok: false,
      error: "zipBomb",
    });
  });

  it("refuses a document part larger than the reading limit", async () => {
    const big = await makeDocxBody(para("a".repeat(5000)));
    expect(
      await extractDocxPages(big, { ownerId: "test-owner", maxXmlBytes: 4096 }),
    ).toEqual({
      ok: false,
      error: "tooLarge",
    });
  });

  it("refuses something that is not a Word document, or one with a DTD", async () => {
    expect(
      await extractDocxPages(new TextEncoder().encode("bukan docx"), {
        ownerId: "test-owner",
      }),
    ).toEqual({
      ok: false,
      error: "damaged",
    });
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file(
      "word/document.xml",
      `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><w:document xmlns:w="${W_NS}" xmlns:m="${M_NS}"><w:body><w:p><w:r><w:t>&b;</w:t></w:r></w:p></w:body></w:document>`,
    );
    const withDtd = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    });
    expect(await extractDocxPages(withDtd, { ownerId: "test-owner" })).toEqual({
      ok: false,
      error: "damaged",
    });
  });
});
