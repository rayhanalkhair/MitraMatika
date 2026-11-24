// S-02: a label ("A.", the item number, a step number) shares the baseline of the first line of
// the content next to it, also when that line holds a formula taller than a text line. Real PDFs,
// read back with pdf.js: the label's and the next word's text items must have the same y.
import { beforeAll, describe, expect, it } from "vitest";
import { snapshot, template, version } from "../../test-support";
import { buildDocumentModel, type ExportDocument } from "../document-model";
import { loadPdfFonts } from "./fonts";
import { readPages, renderForTest, type TextItem } from "./test-pdf";

beforeAll(loadPdfFonts);

const SLOW = 90_000;
/** Taller than a 16.8 pt line at 12 pt: its box is 1.005 em high, lifted 6 pt. */
const TALL = String.raw`$\sqrt{x^2+y^2}$`;
const TOLERANCE = 0.3;

const withColumns = (doc: ExportDocument, columns: 1 | 2 | 4): ExportDocument => ({
  ...doc,
  sections: doc.sections.map((section) => ({
    ...section,
    items: section.items.map((item) => ({ ...item, columns })),
  })),
});

function build(
  font: "times" | "arial",
  stem: string,
  texts: string[],
  steps: string[],
  columns: 1 | 2 | 4,
) {
  const options = (["A", "B", "C", "D"] as const).map((label, index) => ({
    label,
    textMd: texts[index],
  }));
  const doc = buildDocumentModel(
    snapshot({}, { i1: version(stem, "A", { options, steps }) }),
    { ...template, font },
  );
  return withColumns(doc, columns);
}

const only = (items: TextItem[], text: string): TextItem[] =>
  items.filter((item) => item.text === text);

describe.each(["times", "arial"] as const)("label baselines (%s)", (font) => {
  it.each([1, 2, 4] as const)(
    "an option label and its text share a baseline in %i column(s)",
    async (columns) => {
      const texts = ["A", "B", "C", "D"].map((tag) => `${TALL} cm${tag}`);
      const doc = build(font, "Soal", texts, ["Langkah"], columns);
      const { bytes } = await renderForTest(doc, "paper");
      const [page] = await readPages(bytes);
      for (const tag of ["A", "B", "C", "D"]) {
        const [label] = only(page.items, `${tag}.`);
        const [word] = only(page.items, `cm${tag}`);
        expect(label, tag).toBeDefined();
        expect(word, tag).toBeDefined();
        expect(Math.abs(label.y - word.y), `${tag} (${String(columns)})`).toBeLessThan(
          TOLERANCE,
        );
      }
    },
    SLOW,
  );

  it(
    "an option label stays on the baseline of plain text and of a short formula",
    async () => {
      const doc = build(
        font,
        "Soal",
        ["pilih A", "$8$ satuanB", "C teks", "D"],
        ["x"],
        2,
      );
      const { bytes } = await renderForTest(doc, "paper");
      const [page] = await readPages(bytes);
      const [label] = only(page.items, "B.");
      const [word] = only(page.items, "satuanB");
      expect(Math.abs(label.y - word.y)).toBeLessThan(TOLERANCE);
    },
    SLOW,
  );

  it(
    "the item number shares the baseline of a stem that starts with a tall formula",
    async () => {
      const doc = build(font, `${TALL} stemkata`, ["a", "b", "c", "d"], ["x"], 4);
      const { bytes } = await renderForTest(doc, "paper");
      const [page] = await readPages(bytes);
      const [number] = only(page.items, "1.");
      const [word] = only(page.items, "stemkata");
      expect(Math.abs(number.y - word.y)).toBeLessThan(TOLERANCE);
    },
    SLOW,
  );

  it(
    "solutions: the item number and the step numbers share the baseline of their text",
    async () => {
      const doc = build(
        font,
        `${TALL} stemkata`,
        ["a", "b", "c", "d"],
        [`${TALL} langkahsatu`, `${TALL} langkahdua`],
        4,
      );
      const { bytes } = await renderForTest(doc, "solutions");
      const [page] = await readPages(bytes);
      const ones = only(page.items, "1.");
      const [stem] = only(page.items, "stemkata");
      const [first] = only(page.items, "langkahsatu");
      const [second] = only(page.items, "langkahdua");
      // The item number is the "1." at the stem's line, the step numbers are the others.
      const numberOne = ones.find((item) => Math.abs(item.y - stem.y) < TOLERANCE);
      expect(numberOne).toBeDefined();
      const stepOne = ones.find((item) => Math.abs(item.y - first.y) < TOLERANCE);
      expect(stepOne).toBeDefined();
      const [stepTwo] = only(page.items, "2.");
      expect(Math.abs(stepTwo.y - second.y)).toBeLessThan(TOLERANCE);
    },
    SLOW,
  );
});
