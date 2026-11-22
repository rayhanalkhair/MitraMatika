// Real PDFs: the documents are laid out by React-PDF and read back with pdf.js (through unpdf).
// These tests render for real (no mocks, no binary needed); fixtures are kept lean on purpose.
import { beforeAll, describe, expect, it } from "vitest";
import { longSnapshot, snapshot, template, version } from "../../test-support";
import { buildDocumentModel } from "../document-model";
import { MARGIN_PT, PAGE_PT } from "./context";
import { ExportPdfDocument } from "./document";
import { loadPdfFonts } from "./fonts";
import {
  elementsOf,
  newContext,
  readInfo,
  readPages,
  renderForTest,
  type PdfPage,
} from "./test-pdf";

beforeAll(loadPdfFonts);

const SLOW = 90_000;

const paper = (overrides = {}, versions = {}, tpl = template) =>
  buildDocumentModel(snapshot(overrides, versions), tpl);

/** Every page has exactly one "Halaman n dari N" with the right numbers. */
function expectFooters(pages: PdfPage[]) {
  pages.forEach((page, index) => {
    const footers = [...page.text.matchAll(/Halaman (\d+) dari (\d+)/g)];
    expect(footers.length, `page ${String(index + 1)}`).toBe(1);
    expect(footers[0][1]).toBe(String(index + 1));
    expect(footers[0][2]).toBe(String(pages.length));
  });
}

const pageOf = (pages: PdfPage[], marker: string) =>
  pages.findIndex((page) => page.text.includes(marker));

/** A stem of `chars` characters of prose, then a 12-row matrix, with markers at both ends. */
function oversizedStem(chars: number): string {
  const rows = Array.from(
    { length: 12 },
    (_, i) => `${String(i + 1)} & ${String(i + 2)} & x_{${String(i + 1)}}`,
  ).join(String.raw` \\ `);
  const prose = "persegi panjang keliling luas sisi segitiga sudut lingkaran ".repeat(
    100,
  );
  return `AWAL-BIG ${prose.slice(0, chars)} AKHIR-STEM\n\n$$\\begin{bmatrix}${rows}\\end{bmatrix}$$\n\nAKHIR-BIG`;
}

describe("page and content", () => {
  it(
    "prints an A4 paper: letterhead, title, first stem, footer",
    async () => {
      const { bytes, ctx } = await renderForTest(paper(), "paper");
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
      const pages = await readPages(bytes);
      expect(pages).toHaveLength(1);
      expect(Math.abs(pages[0].width - PAGE_PT.A4[0])).toBeLessThan(2);
      expect(Math.abs(pages[0].height - PAGE_PT.A4[1])).toBeLessThan(2);
      const text = pages[0].text;
      expect(text.indexOf("SMP Negeri 1 Contoh")).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("SMP Negeri 1 Contoh")).toBeLessThan(
        text.indexOf("NASKAH SOAL"),
      );
      expect(text).toContain("Soal i1");
      expect(text).toContain("Halaman 1 dari 1");
      expect(ctx.warnings).toEqual([]);
    },
    SLOW,
  );

  it(
    "prints F4 at 215 x 330 mm, in Arial",
    async () => {
      const doc = paper({}, {}, { ...template, paperSize: "F4", font: "arial" });
      const { bytes } = await renderForTest(doc, "paper");
      const [page] = await readPages(bytes);
      expect(Math.abs(page.width - PAGE_PT.F4[0])).toBeLessThan(2);
      expect(Math.abs(page.height - PAGE_PT.F4[1])).toBeLessThan(2);
    },
    SLOW,
  );

  it(
    "keeps the characters of a failed formula's source in the embedded font",
    async () => {
      const doc = paper(
        {},
        { i1: version("Hitung $\\foo{α ≤ x}$ dan $$\\baz{π ≥ ∞ √ ±}$$ lalu selesai.") },
      );
      const { bytes, ctx } = await renderForTest(doc, "paper");
      expect(
        ctx.warnings.filter((warning) => warning.code === "mathFailed"),
      ).toHaveLength(2);
      const [{ text }] = await readPages(bytes);
      expect(text).toContain("α ≤ x");
      expect(text).toContain("π ≥ ∞ √ ±");
      // The fallback must not use the (non-embedded, WinAnsi-only) Courier for these characters.
      const raw = Buffer.from(bytes).toString("latin1");
      expect(raw).toMatch(/\+LiberationSerif/);
    },
    SLOW,
  );

  it(
    "prints the student fields only when the template has them",
    async () => {
      const [{ text: withFields }] = await readPages(
        (await renderForTest(paper(), "paper")).bytes,
      );
      expect(withFields).toContain("Nama");
      expect(withFields).toContain("Kelas");
      const none = paper({}, {}, { ...template, studentFields: ["date"] });
      const [{ text: dateOnly }] = await readPages(
        (await renderForTest(none, "paper")).bytes,
      );
      expect(dateOnly).toContain("Tanggal");
      expect(dateOnly).not.toContain("Nama");
      const bare = paper({}, {}, { ...template, studentFields: [] });
      const [{ text: nothing }] = await readPages(
        (await renderForTest(bare, "paper")).bytes,
      );
      expect(nothing).not.toContain("Nama");
      expect(nothing).not.toContain("Tanggal");
    },
    SLOW,
  );

  it(
    "prints the key table and the solutions",
    async () => {
      const doc = paper();
      const [key] = await readPages((await renderForTest(doc, "key")).bytes);
      expect(key.text).toContain("KUNCI JAWABAN");
      expect(key.text).toMatch(/No\s+Jawaban\s+Skor/);
      expect(key.text).toContain("Total");
      expect(key.text).toContain("100");
      const [solutions] = await readPages((await renderForTest(doc, "solutions")).bytes);
      expect(solutions.text).toContain("PEMBAHASAN");
      expect(solutions.text).toContain("Jawaban: B. Pilihan B");
      expect(solutions.text).toContain("1.");
      expect(solutions.text).toContain("Langkah dua.");
    },
    SLOW,
  );

  it(
    "sets the title and has no author in the information dictionary",
    async () => {
      const { bytes } = await renderForTest(paper(), "paper");
      const info = await readInfo(bytes);
      expect(info.Title).toBe("Naskah Soal - Ulangan Bab 1");
      expect(info.Creator).toBe("MitraMatika");
      expect(info.Producer).toBe("MitraMatika");
      expect(info.Author ?? "").toBe("");
      expect(info.Subject ?? "").toBe("");
      expect(info.Keywords ?? "").toBe("");
    },
    SLOW,
  );

  it(
    "draws symbols outside WinAnsi, the glyph boxes for the not-in and not-equal signs, and formulas",
    async () => {
      const stem =
        "Diketahui a ∉ B, x ≠ 0, ∠A ⊥ ∠B dan $\\frac{1}{2} + \\sqrt{x}$ serta 24 cm^2.";
      const { bytes, ctx } = await renderForTest(
        paper({}, { i1: version(stem) }),
        "paper",
      );
      const [page] = await readPages(bytes);
      expect(page.text).toContain("Diketahui a");
      expect(page.text).toContain("serta 24 cm");
      expect(ctx.warnings).toEqual([]);
      // Nothing is drawn right of the margin.
      const limit = PAGE_PT.A4[0] - MARGIN_PT.right;
      for (const item of page.items)
        expect(item.x + item.width).toBeLessThanOrEqual(limit + 0.5);
    },
    SLOW,
  );
});

describe("the logo", () => {
  const PNG_1X1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it(
    "embeds a PNG logo as an image from its bytes",
    async () => {
      const doc = buildDocumentModel(snapshot(), template, {
        logo: { bytes: Buffer.from(PNG_1X1, "base64"), contentType: "image/png" },
      });
      const { bytes, ctx } = await renderForTest(doc, "paper");
      expect(ctx.warnings).toEqual([]);
      expect(Buffer.from(bytes).toString("latin1")).toContain("/Subtype /Image");
    },
    SLOW,
  );

  it(
    "omits an SVG logo and still renders the document",
    async () => {
      const doc = {
        ...paper(),
        header: { ...paper().header, logoDataUri: "data:image/svg+xml;base64,PHN2Zy8+" },
      };
      const { bytes, ctx } = await renderForTest(doc, "paper");
      expect(ctx.warnings.map((warning) => warning.code)).toEqual(["logoOmitted"]);
      expect(Buffer.from(bytes).toString("latin1")).not.toContain("/Subtype /Image");
      expect((await readPages(bytes))[0].text).toContain("SMP Negeri 1 Contoh");
    },
    SLOW,
  );
});

describe("pagination", () => {
  it(
    "keeps every question on one page with one footer per page (30 long items)",
    async () => {
      const doc = buildDocumentModel(longSnapshot(30), template);
      // The fixture crosses FLOW_PAGES, so footer numbering is checked across Page elements.
      const flows = elementsOf(
        ExportPdfDocument({ doc, kind: "paper", ctx: newContext() }),
      ).filter((element) => element.props.size !== undefined);
      expect(flows.length).toBeGreaterThan(1);
      const { bytes } = await renderForTest(doc, "paper");
      const pages = await readPages(bytes);
      expect(pages.length).toBeGreaterThan(2);
      expectFooters(pages);
      for (let n = 1; n <= 30; n++) {
        const label = String(n).padStart(2, "0");
        const first = pageOf(pages, `AWAL-${label} `);
        const last = pageOf(pages, `AKHIR-${label}`);
        expect(first, `AWAL-${label}`).toBeGreaterThanOrEqual(0);
        expect(first, `item ${label} is split`).toBe(last);
      }
    },
    SLOW,
  );

  it.each([3200, 5000])(
    "draws an item taller than a page in full, footer count right (%i characters + 12-row matrix)",
    async (chars) => {
      const doc = paper({}, { i1: version(oversizedStem(chars), "A", { options: [] }) });
      const { bytes, ctx } = await renderForTest(doc, "paper");
      const pages = await readPages(bytes);
      const all = pages.map((page) => page.text).join(" ");
      expect(all).toContain("AWAL-BIG");
      expect(all).toContain("AKHIR-STEM");
      expect(all).toContain("AKHIR-BIG");
      expect(all).toContain("Soal i5");
      expectFooters(pages);
      // No body text at or below the footer line.
      for (const page of pages) {
        const footer = page.items.find((item) => item.text.startsWith("Halaman"));
        expect(footer).toBeDefined();
        for (const item of page.items) {
          if (item === footer) continue;
          expect(item.y).toBeGreaterThan((footer?.y ?? 0) + 10);
        }
      }
      expect(ctx.warnings).toEqual([]);
    },
    SLOW,
  );

  it(
    "keeps a section heading with its first question",
    async () => {
      const doc = buildDocumentModel(longSnapshot(30), template);
      const pages = await readPages((await renderForTest(doc, "paper")).bytes);
      // The heading "A. Pilihan ganda" sits on the same page as the first item, never alone.
      expect(pageOf(pages, "A. Pilihan ganda")).toBe(pageOf(pages, "AWAL-01 "));
    },
    SLOW,
  );
});

describe("a flow cut", () => {
  it(
    "keeps a section heading on the page of its first question when the cut falls there",
    async () => {
      const doc = buildDocumentModel(snapshot(), template);
      // Find a flow length that starts a new Page exactly at the second section's heading.
      let cutAt: number | undefined;
      for (let flow = 0.02; flow <= 0.6 && cutAt === undefined; flow += 0.01) {
        const root = ExportPdfDocument({
          doc,
          kind: "paper",
          ctx: newContext(),
          flowPages: flow,
        });
        const pages = elementsOf((root.props as { children?: unknown }).children).filter(
          (element) => element.props.size !== undefined,
        );
        const startsWithHeading = pages.some(
          (page) =>
            elementsOf(page.props.children).find((e) => e.key !== null)?.key ===
            "heading-1",
        );
        if (startsWithHeading) cutAt = flow;
      }
      expect(cutAt).toBeDefined();
      const { bytes } = await renderForTest(doc, "paper", newContext(), cutAt);
      const pages = await readPages(bytes);
      expect(pages.length).toBeGreaterThan(1);
      expect(pageOf(pages, "B. Lanjutan")).toBe(pageOf(pages, "Soal i4"));
      expectFooters(pages);
    },
    SLOW,
  );
});

describe("nothing is drawn past the right margin", () => {
  const limit = PAGE_PT.A4[0] - MARGIN_PT.right;

  it(
    "wraps an unbroken 300-character string in a stem",
    async () => {
      const stem = `Kata: ${"a".repeat(300)} selesai.`;
      const { bytes } = await renderForTest(paper({}, { i1: version(stem) }), "paper");
      const [page] = await readPages(bytes);
      for (const item of page.items)
        expect(item.x + item.width).toBeLessThanOrEqual(limit + 0.5);
      expect(page.text.replaceAll(/[-\s]/g, "")).toContain("a".repeat(300));
    },
    SLOW,
  );

  it(
    "wraps a 300-character string and a long formula in a 4-column option",
    async () => {
      const options = [
        { label: "A" as const, textMd: "b".repeat(300) },
        {
          label: "B" as const,
          textMd: String.raw`$\frac{123456}{789} + \frac{98765}{4321}$`,
        },
        { label: "C" as const, textMd: "W".repeat(40) },
        { label: "D" as const, textMd: "singkat" },
      ];
      const doc = paper({}, { i1: version("Soal lebar", "A", { options }) });
      expect(doc.sections[0].items[0].columns).toBe(1); // the text is long: the model picks 1 column...
      const forced = {
        ...doc,
        sections: doc.sections.map((section) => ({
          ...section,
          items: section.items.map((item) => ({ ...item, columns: 4 as const })),
        })),
      };
      const { bytes } = await renderForTest(forced, "paper");
      const [page] = await readPages(bytes);
      for (const item of page.items)
        expect(item.x + item.width).toBeLessThanOrEqual(limit + 0.5);
    },
    SLOW,
  );

  it(
    "keeps a 40-character word of wide letters inside its 4-column option cell",
    async () => {
      // The hyphenation callback cuts at 40 code points, not at a width: 40 capital Ws are about
      // 450 pt at 12 pt, far wider than a cell (about 100 pt).
      const options = [
        { label: "A" as const, textMd: "W".repeat(40) },
        { label: "B" as const, textMd: "WWWWWWWWWW MMMMMMMMMM" },
        { label: "C" as const, textMd: "pendek" },
        { label: "D" as const, textMd: "pendek" },
      ];
      const doc = paper({}, { i1: version("Soal W", "A", { options }) });
      const forced = {
        ...doc,
        sections: doc.sections.map((section) => ({
          ...section,
          items: section.items.map((item) => ({ ...item, columns: 4 as const })),
        })),
      };
      const { bytes } = await renderForTest(forced, "paper");
      const [page] = await readPages(bytes);
      // Each cell's text ends before the label of the next cell (or the right margin).
      const labelX = ["A.", "B.", "C.", "D."].map((label) => {
        const found = page.items.find((item) => item.text === label);
        expect(found, label).toBeDefined();
        return found?.x ?? 0;
      });
      const edges = [...labelX.slice(1), limit];
      const wide = page.items.filter((item) => /^[WM]+-?$/.test(item.text));
      expect(wide.length).toBeGreaterThan(2);
      for (const item of wide) {
        const cell = labelX.findLastIndex((x) => item.x >= x - 0.5);
        expect(
          item.x + item.width,
          `${item.text} in cell ${String(cell)}`,
        ).toBeLessThanOrEqual(edges[cell] + 0.5);
      }
    },
    SLOW,
  );
});
