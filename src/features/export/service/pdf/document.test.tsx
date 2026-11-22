// The element tree of the PDF documents, asserted without rendering a PDF (layout.test.ts renders
// real ones). The components are plain functions, so the tree is available straight away.
import { isValidElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { longSnapshot, snapshot, template, version } from "../../test-support";
import {
  buildDocumentModel,
  keyRows,
  type ExportDocument,
  type ExportItem,
} from "../document-model";
import { formatPoints, type DocumentKind } from "../render-html";
import { layoutFor, MARGIN_PT } from "./context";
import { ExportPdfDocument, PAGE_PT } from "./document";
import { loadPdfFonts } from "./fonts";
import { logoImage } from "./letterhead";
import { elementsOf, newContext, stringsOf, type LooseElement } from "./test-pdf";

beforeAll(loadPdfFonts);

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SVG_LOGO = "data:image/svg+xml;base64,PHN2Zy8+";

function tree(doc: ExportDocument, kind: DocumentKind) {
  const ctx = newContext();
  const root = ExportPdfDocument({ doc, kind, ctx });
  return { root, ctx, elements: elementsOf(root) };
}

const model = (overrides = {}, versions = {}) =>
  buildDocumentModel(snapshot(overrides, versions), template);

/** The same model with `columns` forced on every item. */
function withColumns(
  doc: ExportDocument,
  columns: ExportItem["columns"],
): ExportDocument {
  return {
    ...doc,
    sections: doc.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({ ...item, columns })),
    })),
  };
}

const itemViews = (elements: ReturnType<typeof elementsOf>) =>
  elements.filter((element) => /^q-\d+$/.test(String(element.props.id)));

describe("paper", () => {
  it("has one whole (wrap false) View per model item, in model order", () => {
    const doc = model();
    const items = itemViews(tree(doc, "paper").elements);
    const expected = doc.sections.flatMap((section) => section.items);
    expect(items.map((item) => item.props.id)).toEqual(
      expected.map((item) => `q-${String(item.number)}`),
    );
    expect(items).toHaveLength(5);
    for (const item of items) expect(item.props.wrap).toBe(false);
  });

  it("keeps the shuffled numbering of the model", () => {
    const doc = model({ shuffleSeed: "seed-1" });
    const ids = itemViews(tree(doc, "paper").elements).map((item) => item.props.id);
    const numbers = doc.sections.flatMap((section) =>
      section.items.map((item) => `q-${String(item.number)}`),
    );
    expect(ids).toEqual(numbers);
  });

  it("lets an item that cannot fit a page split (wrap not false) and keeps short ones whole", () => {
    const giant = version("Kalimat panjang yang berulang. ".repeat(160));
    const doc = model({}, { i2: giant });
    const items = itemViews(tree(doc, "paper").elements);
    // The prop is absent for the split item: `wrap={undefined}` would read as "do not wrap".
    expect(
      items.map((item) => ("wrap" in item.props ? item.props.wrap : "absent")),
    ).toEqual([false, "absent", false, false, false]);
  });

  it("decides on the estimate: 90 % of the printable height is the boundary", () => {
    const wrapOf = (lines: number) => {
      const stem = Array.from({ length: lines }, (_, i) => `Baris ${String(i)}`).join(
        "\n",
      );
      const doc = buildDocumentModel(
        snapshot({}, { i1: version(stem, "A", { options: [], steps: [] }) }),
        template,
      );
      const { props } = itemViews(tree(doc, "paper").elements)[0];
      return "wrap" in props ? props.wrap : "absent";
    };
    // A4: 728.5 pt printable, 90 % = 655.6 pt, 16.8 pt per line: 38 lines fit, 40 do not.
    expect(wrapOf(38)).toBe(false);
    expect(wrapOf(40)).toBe("absent");
  });

  it.each([
    [4, 1, 4],
    [2, 2, 2],
    [1, 4, 1],
  ] as const)(
    "lays 4 options of columns %i in %i row(s) of %i cell(s)",
    (columns, rows, cells) => {
      const doc = withColumns(model(), columns);
      const first = itemViews(tree(doc, "paper").elements)[0];
      const optionRows = elementsOf(first).filter((element) =>
        String(element.key).startsWith("row-"),
      );
      expect(optionRows).toHaveLength(rows);
      for (const row of optionRows) {
        expect(
          elementsOf(row).filter((e) => ["A", "B", "C", "D"].includes(String(e.key))),
        ).toHaveLength(cells);
      }
    },
  );

  it("prints the school name, the header lines and the student fields when enabled", () => {
    const text = stringsOf(tree(model(), "paper").root).join("|");
    expect(text).toContain("SMP Negeri 1 Contoh");
    expect(text).toContain("PEMERINTAH KOTA CONTOH");
    expect(text).toContain("Nama");
    expect(text).toContain("Kelas");
    expect(text).toContain("Petunjuk:");
    expect(text).toContain("Berdoalah dahulu.");
    const without = buildDocumentModel(snapshot(), { ...template, studentFields: [] });
    const bare = stringsOf(tree(without, "paper").root).join("|");
    expect(bare).not.toContain("Nama");
  });

  it("sets the metadata without personal data", () => {
    const { root } = tree(model(), "paper");
    const props = root.props as Record<string, unknown>;
    expect(props.title).toBe("Naskah Soal - Ulangan Bab 1");
    expect(props.creator).toBe("MitraMatika");
    expect(props.producer).toBe("MitraMatika");
    expect(props.language).toBe("id");
    expect(props.author).toBeUndefined();
    expect(props.subject).toBeUndefined();
    expect(props.keywords).toBeUndefined();
  });

  it("uses the page sizes of A4 and F4", () => {
    expect(PAGE_PT).toEqual({ A4: [595.28, 841.89], F4: [609.45, 935.43] });
    const f4 = buildDocumentModel(snapshot(), { ...template, paperSize: "F4" });
    const page = tree(f4, "paper").elements.find(
      (element) => element.props.size !== undefined,
    );
    expect(page?.props.size).toEqual([609.45, 935.43]);
  });
});

describe("key", () => {
  it("has the rows of keyRows and the total of the points", () => {
    const doc = model();
    const text = tree(doc, "key")
      .elements.filter((element) => String(element.key).startsWith("row-"))
      .map((row) => stringsOf(row.props.children).join(","));
    expect(text).toEqual(
      keyRows(doc).map(
        (row) => `${String(row.number)},${row.answer},${formatPoints(row.points)}`,
      ),
    );
    const total = keyRows(doc).reduce((sum, row) => sum + row.points, 0);
    const totalRow = tree(doc, "key").elements.find((element) => element.key === "total");
    expect(stringsOf(totalRow?.props.children)).toEqual(["Total", formatPoints(total)]);
  });

  it("has no questions and no student fields", () => {
    const { elements, root } = tree(model(), "key");
    expect(itemViews(elements)).toHaveLength(0);
    const text = stringsOf(root).join("|");
    expect(text).toContain("KUNCI JAWABAN");
    expect(text).not.toContain("Petunjuk");
  });
});

describe("solutions", () => {
  it("prints the answer with the correct option and numbered steps", () => {
    const { elements } = tree(model(), "solutions");
    const first = itemViews(elements)[0];
    const text = stringsOf(first);
    expect(text.join("")).toContain("Jawaban: A. Pilihan A");
    expect(text).toContain("1.");
    expect(text).toContain("2.");
    expect(text).toContain("Langkah satu.");
  });
});

describe("the logo", () => {
  it("draws a PNG from bytes, never from a URL", () => {
    const doc = buildDocumentModel(snapshot(), template, {
      logo: { bytes: Buffer.from(PNG_1X1, "base64"), contentType: "image/png" },
    });
    const { elements, ctx } = tree(doc, "paper");
    const images = elements.filter((element) => element.props.src !== undefined);
    expect(images).toHaveLength(1);
    const { src } = images[0].props as { src: { data: unknown; format: string } };
    expect(typeof src).toBe("object");
    expect(Buffer.isBuffer(src.data)).toBe(true);
    expect(src.format).toBe("png");
    expect(ctx.warnings).toEqual([]);
  });

  it("leaves an SVG logo out with a logoOmitted warning", () => {
    const doc = { ...model(), header: { ...model().header, logoDataUri: SVG_LOGO } };
    const { elements, ctx } = tree(doc, "paper");
    expect(elements.filter((element) => element.props.src !== undefined)).toHaveLength(0);
    expect(ctx.warnings).toEqual([
      { code: "logoOmitted", where: { part: "letterhead" }, source: "image/svg+xml" },
    ]);
  });

  it("leaves out a PNG whose header cannot be read", () => {
    const ctx = newContext();
    const broken = `data:image/png;base64,${Buffer.from("not a png at all, really").toString("base64")}`;
    expect(logoImage(broken, ctx)).toBeNull();
    expect(logoImage("data:text/html;base64,AAAA", ctx)).toBeNull();
    expect(ctx.warnings.map((warning) => warning.code)).toEqual([
      "logoOmitted",
      "logoOmitted",
    ]);
    expect(logoImage(null, ctx)).toBeNull();
    expect(ctx.warnings).toHaveLength(2);
  });
});

describe("formulas and warnings", () => {
  it("records mathFailed with the place and keeps the source as text", () => {
    const doc = model({}, { i1: version("Hitung $\\foo{x}$ sekarang.") });
    const { root, ctx } = tree(doc, "paper");
    expect(ctx.warnings).toEqual([
      { code: "mathFailed", where: { part: "stem", number: 1 }, source: "\\foo{x}" },
    ]);
    const text = stringsOf(root).join("|");
    expect(text).toContain("$\\foo{x}$");
  });

  it("draws a good formula as an Svg inside a wrapping row", () => {
    const doc = model(
      {},
      { i1: version(String.raw`Nilai $\frac{1}{2}$ adalah setengah.`) },
    );
    const first = itemViews(tree(doc, "paper").elements)[0];
    const parts = elementsOf(first);
    expect(parts.find((element) => element.props.viewBox !== undefined)).toBeDefined();
    const row = parts.find(
      (element) =>
        (element.props.style as { flexWrap?: string } | undefined)?.flexWrap === "wrap",
    );
    expect(row).toBeDefined();
  });

  describe("the baseline offset (spike S3: marginBottom = 0.5 * fs - depthEm * fs * scale)", () => {
    const svgOf = (source: string) => {
      const doc = model({}, { i1: version(`Nilai ${source} ok.`, "A", { options: [] }) });
      const { elements, ctx } = tree(doc, "paper");
      const svg = elements.find((element) => element.props.viewBox !== undefined);
      const props = svg?.props as { width: number; style: { marginBottom: number } };
      const raw = source.slice(1, -1);
      const box = ctx.math(raw, false);
      if (box instanceof Error) throw box;
      return { props, box, scale: props.width / (box.widthEm * 12) };
    };

    it("with a depth (a fraction) lifts by 6 pt minus the depth", () => {
      const { props, box, scale } = svgOf(String.raw`$\frac{1}{2}$`);
      expect(box.depthEm).toBeGreaterThan(0.1);
      expect(scale).toBeCloseTo(1, 5);
      expect(props.style.marginBottom).toBeCloseTo(0.5 * 12 - box.depthEm * 12, 5);
      expect(props.style.marginBottom).toBeLessThan(5);
    });

    it("without a depth (a letter) lifts by the full 6 pt", () => {
      const { props, box } = svgOf("$H$");
      expect(box.depthEm).toBeCloseTo(0, 2);
      expect(props.style.marginBottom).toBeCloseTo(0.5 * 12 - box.depthEm * 12, 5);
      expect(props.style.marginBottom).toBeGreaterThan(5.9);
    });

    it("scales the depth with a shrunk formula", () => {
      const { props, box, scale } = svgOf(
        String.raw`$\frac{1}{2} + ${"x + ".repeat(22)}\frac{1}{2}$`,
      );
      expect(scale).toBeLessThan(1);
      expect(scale).toBeGreaterThan(0.3);
      expect(box.depthEm).toBeGreaterThan(0.1);
      expect(props.style.marginBottom).toBeCloseTo(
        0.5 * 12 - box.depthEm * 12 * scale,
        5,
      );
    });
  });

  it("keeps a wide formula inside a 4-column option cell (options B and D)", () => {
    const wide = `$${"x + ".repeat(14)}y$`;
    const options = [
      { label: "A" as const, textMd: "pendek" },
      { label: "B" as const, textMd: wide },
      { label: "C" as const, textMd: "pendek" },
      { label: "D" as const, textMd: wide },
    ];
    const base = model({}, { i1: version("Soal", "A", { options }) });
    const doc = withColumns(base, 4);
    const lay = layoutFor("A4", "times");
    const cell = (lay.contentWidth - 28 - 3 * 14) / 4;
    const textWidth = cell - 14 - 5;
    const { elements, ctx } = tree(doc, "paper");
    const first = itemViews(elements)[0];
    for (const label of ["B", "D"]) {
      const cellView = elementsOf(first).find(
        (element) => element.key === label && element.props.style !== undefined,
      );
      const svgs = elementsOf(cellView).filter(
        (element) => element.props.viewBox !== undefined,
      );
      expect(svgs, label).toHaveLength(1);
      expect((svgs[0].props as { width: number }).width, label).toBeLessThanOrEqual(
        textWidth + 0.01,
      );
    }
    const wideWarnings = ctx.warnings.filter((warning) => warning.code === "mathTooWide");
    expect(
      wideWarnings.map((warning) => (warning.where as { label?: string }).label),
    ).toEqual(["B", "D"]);
  });

  it("records where a failed formula sits: option, solution step, correct option in solutions", () => {
    const versions = {
      i1: version("Soal", "A", {
        options: [
          { label: "A", textMd: String.raw`$\foo{a}$` },
          { label: "B", textMd: String.raw`$\foo{b}$` },
          { label: "C", textMd: "c" },
          { label: "D", textMd: "d" },
        ],
        steps: ["Satu", String.raw`Dua $\foo{s}$`],
      }),
    };
    const paperWarnings = tree(model({}, versions), "paper").ctx.warnings;
    expect(paperWarnings.map((warning) => warning.where)).toEqual([
      { part: "option", number: 1, label: "A" },
      { part: "option", number: 1, label: "B" },
    ]);
    const solutionWarnings = tree(model({}, versions), "solutions").ctx.warnings;
    expect(solutionWarnings.map((warning) => warning.where)).toEqual([
      { part: "option", number: 1, label: "A" },
      { part: "step", number: 1, step: 2 },
    ]);
  });

  it("warns mathTooWide for a display formula wider than the page even at 70 %, and shrinks it to fit", () => {
    const wide = `$$${"x + ".repeat(40)}y$$`;
    const doc = model({}, { i1: version(wide) });
    const { ctx, elements } = tree(doc, "paper");
    expect(ctx.warnings.map((warning) => warning.code)).toEqual(["mathTooWide"]);
    const svg = elements.find((element) => element.props.viewBox !== undefined);
    const width = (svg?.props as { width: number }).width;
    const available = PAGE_PT.A4[0] - 2 * MARGIN_PT.left - 28;
    expect(width).toBeLessThanOrEqual(available + 0.01);
  });

  it("sets a unit exponent as a superscript run and leaves plain prose as one Text", () => {
    const doc = model({}, { i1: version("Luas 24 cm^2 saja.", "A", { options: [] }) });
    const first = itemViews(tree(doc, "paper").elements)[0];
    const sup = elementsOf(first).filter(
      (element) =>
        (element.props.style as { verticalAlign?: string } | undefined)?.verticalAlign ===
        "super",
    );
    expect(sup.map((element) => stringsOf(element))).toEqual([["2"]]);
    const rows = elementsOf(first).filter(
      (element) =>
        (element.props.style as { flexWrap?: string } | undefined)?.flexWrap === "wrap",
    );
    expect(rows).toHaveLength(0);
  });
});

describe("long documents", () => {
  it("builds 30 whole items for the long fixture", () => {
    const doc = buildDocumentModel(longSnapshot(30), template);
    expect(itemViews(tree(doc, "paper").elements)).toHaveLength(30);
  });

  it("cuts a very long flow into several Page elements (React-PDF re-lays out the rest of a flow at every page break), each item once and in order", () => {
    const doc = buildDocumentModel(longSnapshot(90), template);
    const { root, elements } = tree(doc, "paper");
    const pages = elementsOf((root.props as { children?: unknown }).children);
    expect(
      pages.filter((element) => element.props.size !== undefined).length,
    ).toBeGreaterThan(1);
    const ids = itemViews(elements).map((element) => element.props.id);
    expect(ids).toEqual(Array.from({ length: 90 }, (_, i) => `q-${String(i + 1)}`));
    // Every Page element carries the footer.
    const footers = elements.filter(
      (element) => typeof element.props.render === "function",
    );
    expect(footers).toHaveLength(pages.filter((e) => e.props.size !== undefined).length);
  });

  it("keeps a small paper in one flow", () => {
    const { root } = tree(model(), "paper");
    const pages = elementsOf((root.props as { children?: unknown }).children).filter(
      (element) => element.props.size !== undefined,
    );
    expect(pages).toHaveLength(1);
  });
});

describe("flow cuts and section headings", () => {
  /** The nodes of each Page element, without the footer. */
  function groupsOf(doc: ExportDocument, flowPages: number) {
    const root = ExportPdfDocument({ doc, kind: "paper", ctx: newContext(), flowPages });
    return elementsOf((root.props as { children?: unknown }).children)
      .filter((element) => element.props.size !== undefined)
      .map((page) =>
        (page.props.children as unknown[])
          .flat()
          .filter((node): node is LooseElement => isValidElement(node))
          .filter((node) => node.key !== "footer"),
      );
  }
  const keyOf = (node: LooseElement | undefined) => node?.key ?? "";

  it("never leaves a heading (or its instructions) last in a flow, wherever the cut falls", () => {
    const doc = buildDocumentModel(longSnapshot(8), template);
    // Two sections: the long fixture's one section plus the standard second one.
    const two: ExportDocument = {
      ...doc,
      sections: [
        doc.sections[0],
        {
          title: "B. Lanjutan",
          instructionsMd: "Pilih satu jawaban.",
          items: doc.sections[0].items.map((item) => ({
            ...item,
            number: item.number + 8,
          })),
        },
      ],
    };
    let cutsAtSection = 0;
    for (let flow = 0.1; flow <= 1.6; flow += 0.05) {
      for (const group of groupsOf(two, flow)) {
        const last = keyOf(group.at(-1));
        expect(
          last.startsWith("heading-") || last.startsWith("instructions-"),
          `flow ${flow.toFixed(2)}`,
        ).toBe(false);
        // A group that starts (after the document head) with a heading has an item after it.
        if (keyOf(group[0]).startsWith("heading-")) cutsAtSection++;
      }
    }
    // The sweep did put a cut right before the second section's heading at least once.
    expect(cutsAtSection).toBeGreaterThan(0);
  });
});
