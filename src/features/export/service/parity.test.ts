// Preview (HTML) and PDF are two layouts of one model. Line and page breaks may differ; what must
// not drift is pinned here: item numbering, key rows and total, option columns, the set of
// formulas that fail, letterhead and student-field text (plan 2026-11-22-react-pdf, decision 13).
import katex from "katex";
import { describe, expect, it } from "vitest";
import { withDecimalComma } from "@/components/math/decimal-comma";
import { SMP_CORPUS } from "../test-fixtures/smp-corpus";
import { snapshot, template, version } from "../test-support";
import { buildDocumentModel, keyRows, type ExportDocument } from "./document-model";
import { latexToMathBox, MathBoxError } from "./pdf/math-box";
import { readPages, type TextItem } from "./pdf/test-pdf";
import { formatPoints, renderDocument, type DocumentKind } from "./render-html";
import { renderPdf } from "./render-pdf";
import { KATEX_EXPORT_OPTIONS } from "./rich-text";

const SLOW = 90_000;

interface Line {
  page: number;
  y: number;
  items: TextItem[];
}

/** The PDF's text as lines: page, then top to bottom, items of a line left to right. */
async function pdfLines(doc: ExportDocument, kind: DocumentKind) {
  const { bytes, warnings } = await renderPdf(doc, kind);
  const pages = await readPages(bytes);
  const lines: Line[] = [];
  pages.forEach((page, pageIndex) => {
    const sorted = [...page.items].sort((a, b) => b.y - a.y || a.x - b.x);
    for (const item of sorted) {
      const line = lines.find(
        (candidate) =>
          candidate.page === pageIndex && Math.abs(candidate.y - item.y) < 1.5,
      );
      if (line) line.items.push(item);
      else lines.push({ page: pageIndex, y: item.y, items: [item] });
    }
  });
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  const text = pages.map((page) => page.text).join(" ");
  return { lines, text, warnings };
}

/** The item numbers: "N." texts in the number column (the leftmost one; steps sit further in). */
function pdfNumbers(lines: Line[]): number[] {
  const numbered = lines.flatMap((line) =>
    line.items.slice(0, 1).filter((item) => /^\d+\.$/.test(item.text)),
  );
  const left = Math.min(...numbered.map((item) => item.x));
  return numbered
    .filter((item) => Math.abs(item.x - left) < 1.5)
    .map((item) => Number.parseInt(item.text, 10));
}

const htmlNumbers = (source: string): number[] =>
  [...source.matchAll(/<div class="num">(\d+)\.<\/div>/g)].map((m) => Number(m[1]));

const htmlText = (source: string): string =>
  source
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

const html = (doc: ExportDocument, kind: DocumentKind) =>
  renderDocument(doc, kind, { paper: doc.page.paper, font: doc.page.font });

function itemOf(
  base: ReturnType<typeof snapshot>,
  id: string,
): (typeof base.sections)[number]["items"][number] {
  return {
    ...base.sections[0].items[0],
    itemId: id,
    questionId: `q-${id}`,
    versionId: `v-${id}`,
  };
}

function threeSections(shuffleSeed: number | null = null) {
  const base = snapshot();
  const versions = new Map(base.versions);
  const sections = ["Bagian satu", "Bagian dua", "Bagian tiga"].map((title, s) => ({
    ...base.sections[0],
    id: `x${String(s)}`,
    title,
    items: [0, 1].map((n) => {
      const id = `x${String(s)}${String(n)}`;
      versions.set(`v-${id}`, version(`Soal ${id}`, "C"));
      return itemOf(base, id);
    }),
  }));
  return snapshot({ sections, versions, shuffleSeed });
}

const FIXTURES: [string, () => ExportDocument][] = [
  ["shuffled", () => buildDocumentModel(snapshot({ shuffleSeed: 424242 }), template)],
  ["three sections", () => buildDocumentModel(threeSections(), template)],
  ["three sections, shuffled", () => buildDocumentModel(threeSections(7), template)],
];

describe("item numbers", () => {
  for (const [name, make] of FIXTURES) {
    for (const kind of ["paper", "solutions"] as const) {
      it(
        `${name}: ${kind} numbers match in reading order`,
        async () => {
          const doc = make();
          const expected = doc.sections.flatMap((s) => s.items.map((i) => i.number));
          expect(htmlNumbers(html(doc, kind).html)).toEqual(expected);
          expect(pdfNumbers((await pdfLines(doc, kind)).lines)).toEqual(expected);
        },
        SLOW,
      );
    }
  }
});

describe("answer key", () => {
  for (const [name, make] of FIXTURES) {
    it(
      `${name}: PDF rows, HTML rows and keyRows agree`,
      async () => {
        const doc = make();
        const rows = keyRows(doc).map((row) => [
          String(row.number),
          row.answer,
          formatPoints(row.points),
        ]);
        const key = html(doc, "key").html;
        const fromHtml = [...key.matchAll(/<tr class="key-row">(.*?)<\/tr>/g)].map(
          (row) => [...row[1].matchAll(/<td>(.*?)<\/td>/g)].map((cell) => cell[1]),
        );
        expect(fromHtml).toEqual(rows);

        const { lines } = await pdfLines(doc, "key");
        const fromPdf = lines
          .map((line) => line.items.map((item) => item.text))
          .filter((cells) => cells.length === 3 && /^\d+$/.test(cells[0]));
        expect(fromPdf).toEqual(rows);

        const total = formatPoints(
          keyRows(doc).reduce((sum, row) => sum + Math.round(row.points * 100), 0) / 100,
        );
        const htmlTotal = /<tfoot>.*?<td>([^<]*)<\/td><\/tr><\/tfoot>/.exec(key);
        expect(htmlTotal?.[1]).toBe(total);
        const totalLine = lines.find((line) => line.items[0]?.text === "Total");
        expect(totalLine?.items.map((item) => item.text)).toEqual(["Total", total]);
      },
      SLOW,
    );
  }
});

describe("option columns", () => {
  it(
    "item.columns drives the HTML class and the PDF cell count",
    async () => {
      const base = snapshot();
      const versions = new Map(base.versions);
      const shapes: Record<string, string[]> = {
        c4: ["1", "2", "3", "4"],
        c2: ["lima belas cm", "dua puluh cm", "tiga puluh cm", "empat puluh cm"],
        c1: Array.from({ length: 4 }, (_, i) =>
          `Pilihan panjang nomor ${String(i)} `.repeat(4),
        ),
      };
      const items = Object.entries(shapes).map(([id, texts]) => {
        versions.set(
          `v-${id}`,
          version(`Soal ${id}`, "A", {
            options: texts.map((textMd, i) => ({
              label: (["A", "B", "C", "D"] as const)[i],
              textMd,
            })),
          }),
        );
        return itemOf(base, id);
      });
      const doc = buildDocumentModel(
        snapshot({ sections: [{ ...base.sections[0], items }], versions }),
        template,
      );
      const columns = doc.sections[0].items.map((item) => item.columns);
      expect(columns).toEqual([4, 2, 1]);

      expect(
        [...html(doc, "paper").html.matchAll(/class="options cols-(\d)"/g)].map((m) =>
          Number(m[1]),
        ),
      ).toEqual(columns);

      const { lines } = await pdfLines(doc, "paper");
      const perLine = lines
        .map((line) => line.items.filter((item) => /^[A-D]\.$/.test(item.text)).length)
        .filter((count) => count > 0);
      // Option labels per printed row: 4 columns = one row of 4; 2 = two rows of 2; 1 = four of 1.
      expect(perLine).toEqual([4, 2, 2, 1, 1, 1, 1]);
    },
    SLOW,
  );
});

describe("math failures", () => {
  const bad = [
    String.raw`\frac{1}{`,
    String.raw`\notacommand{x}`,
    String.raw`\sqrt[`,
    "x^",
    "{",
  ];

  it(
    "the same sources fail in the HTML and the PDF",
    async () => {
      const doc = buildDocumentModel(
        snapshot(
          {},
          {
            i1: version(
              String.raw`Hitung $\frac{1}{2}$ dan $\undefinedcommand{x}$ lalu $$\sqrt{2}$$`,
              "A",
            ),
          },
        ),
        template,
      );
      const fromHtml = html(doc, "paper").warnings.filter((w) => w.code === "mathFailed");
      const { warnings, text } = await pdfLines(doc, "paper");
      const fromPdf = warnings.filter((w) => w.code === "mathFailed");
      expect(fromHtml.map((w) => w.source)).toEqual([String.raw`\undefinedcommand{x}`]);
      expect(new Set(fromPdf.map((w) => w.source))).toEqual(
        new Set(fromHtml.map((w) => w.source)),
      );
      // The fallback prints the source as text in both.
      expect(text).toContain(String.raw`$\undefinedcommand{x}$`);
      expect(htmlText(html(doc, "paper").html)).toContain(
        String.raw`\undefinedcommand{x}`,
      );
    },
    SLOW,
  );

  const refuses = (source: string, display: boolean, output: "html" | "mathml") => {
    try {
      katex.renderToString(withDecimalComma(source), {
        ...KATEX_EXPORT_OPTIONS,
        displayMode: display,
        output,
      });
      return false;
    } catch {
      return true;
    }
  };

  it("KaTeX html (preview, Word) and mathml (PDF) refuse the same formulas", () => {
    const sources = [...SMP_CORPUS, ...bad];
    for (const display of [false, true]) {
      const preview = new Set(sources.filter((s) => refuses(s, display, "html")));
      const pdf = new Set(sources.filter((s) => refuses(s, display, "mathml")));
      expect(preview.size).toBeGreaterThan(0);
      expect(pdf).toEqual(preview);
    }
  });

  it("the PDF typesetter refuses the same formulas as the preview", () => {
    const sources = [...SMP_CORPUS, ...bad];
    for (const display of [false, true]) {
      const preview = new Set(sources.filter((s) => refuses(s, display, "html")));
      const pdf = new Set<string>();
      for (const source of sources) {
        try {
          latexToMathBox(source, display);
        } catch (error) {
          if (!(error instanceof MathBoxError)) throw error;
          pdf.add(source);
        }
      }
      expect(pdf).toEqual(preview);
    }
  });
});

describe("known difference: trust-gated commands", () => {
  // With trust off KaTeX does not throw on these (the preview draws them as red text and gives no
  // warning); the PDF typesetter refuses every trust request, so they become mathFailed there
  // (no links or images in a PDF). Pinned so the gap cannot grow unseen.
  const gated = [
    String.raw`\href{https://example.org}{a}`,
    String.raw`\url{https://example.org}`,
    String.raw`\includegraphics{a}`,
  ];

  it.each(gated)("%s: no preview warning, a PDF refusal", (source) => {
    const doc = buildDocumentModel(
      snapshot({}, { i1: version(`$${source}$`) }),
      template,
    );
    expect(html(doc, "paper").warnings).toEqual([]);
    expect(() => latexToMathBox(source, false)).toThrow(MathBoxError);
  });
});

describe("letterhead and student fields", () => {
  it(
    "the letterhead lines, school name and field labels appear in both",
    async () => {
      const doc = buildDocumentModel(snapshot(), {
        ...template,
        studentFields: ["name", "class", "number", "date"],
      });
      const heading = [...doc.header.lines, doc.header.schoolName];
      const wanted = [...heading, ...doc.studentFields.map((field) => field.label)];
      expect(wanted).toHaveLength(3 + 1 + 4);
      const fromHtml = htmlText(html(doc, "paper").html);
      const fromPdf = (await pdfLines(doc, "paper")).text.replace(/\s+/g, " ");
      for (const text of wanted) {
        expect(fromHtml, text).toContain(text);
        // Header lines print in capitals (CSS in the preview, toUpperCase in the PDF).
        const inPdf = doc.header.lines.includes(text) ? text.toUpperCase() : text;
        expect(fromPdf, text).toContain(inPdf);
      }
      // Header lines come above the school name, in the same order, in both.
      for (const haystack of [fromHtml.toLowerCase(), fromPdf.toLowerCase()]) {
        const positions = heading.map((text) => haystack.indexOf(text.toLowerCase()));
        expect(positions.every((position) => position >= 0)).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      }
    },
    SLOW,
  );
});
