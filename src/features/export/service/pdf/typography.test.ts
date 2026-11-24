// S-01: the typographic characters the AI writes in prose ("siku\u2011siku", curly quotes, dashes,
// an ellipsis, no-break spaces, signs) must reach the PDF. The splitByCoverage unit tests pin the
// mapping; the real-PDF test renders them all and reads the text back with pdf.js.
import { beforeAll, describe, expect, it } from "vitest";
import { snapshot, template, version } from "../../test-support";
import { buildDocumentModel } from "../document-model";
import { loadPdfFonts, splitByCoverage } from "./fonts";
import { readPages, renderForTest } from "./test-pdf";

beforeAll(loadPdfFonts);

const SLOW = 90_000;
const textOf = (value: string, font: "times" | "arial" = "times") =>
  splitByCoverage(value, font)
    .map((run) => run.text)
    .join("");

describe("splitByCoverage and the hyphen family", () => {
  it("prints U+2010 and U+2011 as a hyphen-minus (no glyph of their own in Liberation)", () => {
    expect(textOf("siku\u2011siku")).toBe("siku-siku");
    expect(textOf("siku\u2010siku")).toBe("siku-siku");
    expect(textOf("siku\u2011siku", "arial")).toBe("siku-siku");
  });

  it("maps the other look-alike hyphens and drops the soft hyphen", () => {
    expect(textOf("a\u2043b\ufe63c\uff0dd")).toBe("a-b-c-d");
    expect(textOf("ko\u00adnsep")).toBe("konsep");
  });

  it("keeps the real dashes and the minus sign that the font has", () => {
    for (const dash of ["\u2012", "\u2013", "\u2014", "\u2015", "\u2212"]) {
      expect(textOf(`a${dash}b`), dash).toBe(`a${dash}b`);
    }
  });

  it("keeps curly quotes, the ellipsis, spaces and the common signs in one run", () => {
    const prose =
      "\u2018a\u2019 \u201cb\u201d\u2026 a\u00a0b a\u202fb a\u2009b 3 \u00d7 4 \u00f7 2 \u2248 5\u00b0 x\u00b2 y\u00b3 \u00bd";
    expect(textOf(prose)).toBe(prose);
    expect(splitByCoverage(prose, "times")).toHaveLength(1);
  });
});

// Each character with the text pdf.js reads back for it (a no-break space is read as a space;
// U+2010 and U+2011 are deliberately printed as "-").
const CASES: [string, string, string][] = [
  ["non-breaking hyphen", "siku\u2011siku", "siku-siku"],
  ["hyphen", "siku\u2010siku", "siku-siku"],
  ["figure dash", "10\u201220", "10\u201220"],
  ["en dash", "10\u201320", "10\u201320"],
  ["em dash", "ya\u2014tidak", "ya\u2014tidak"],
  ["minus sign in prose", "nilai \u22123", "nilai \u22123"],
  ["curly quotes", "\u2018a\u2019 dan \u201cb\u201d", "\u2018a\u2019 dan \u201cb\u201d"],
  ["ellipsis", "dan seterusnya\u2026", "dan seterusnya\u2026"],
  ["times and divide", "3\u00d74 dan 8\u00f72", "3\u00d74 dan 8\u00f72"],
  ["approximately", "pi\u22483", "pi\u22483"],
  ["degree", "sudut 90\u00b0", "sudut 90\u00b0"],
  ["powers and fraction", "m\u00b2 m\u00b3 \u00bd", "m\u00b2 m\u00b3 \u00bd"],
  ["soft hyphen", "ko\u00adnsep", "konsep"],
  ["no-break space", "8\u00a0cm", "8 cm"],
  ["narrow no-break space", "8\u202fcm", "8 cm"],
  ["thin space", "8\u2009cm", "8 cm"],
];

describe.each(["times", "arial"] as const)(
  "typographic characters in a real PDF (%s)",
  (font) => {
    it(
      "prints every character of the list (or its deliberate mapping) in the stem",
      async () => {
        const stem = CASES.map(([, input]) => input).join("\n\n");
        const doc = buildDocumentModel(snapshot({}, { i1: version(stem) }), {
          ...template,
          font,
        });
        const { bytes, ctx } = await renderForTest(doc, "paper");
        const [page] = await readPages(bytes);
        // A non-breaking or thin space is read back as a plain space by pdf.js.
        const text = page.text.replace(/[\u00a0\u202f\u2009]/g, " ");
        for (const [name, , expected] of CASES) {
          expect(text, name).toContain(expected);
        }
        expect(text).not.toContain("sikusiku");
        expect(ctx.warnings).toEqual([]);
      },
      SLOW,
    );

    it(
      "prints the non-breaking hyphen in an option and in a solution step too",
      async () => {
        const options = (["A", "B", "C", "D"] as const).map((label) => ({
          label,
          textMd: `segitiga siku\u2011siku ${label}`,
        }));
        const doc = buildDocumentModel(
          snapshot(
            {},
            {
              i1: version("Soal", "A", {
                options,
                steps: ["Segitiga siku\u2011siku punya sudut 90\u00b0."],
              }),
            },
          ),
          { ...template, font },
        );
        for (const kind of ["paper", "solutions"] as const) {
          const { bytes } = await renderForTest(doc, kind);
          const [page] = await readPages(bytes);
          expect(page.text, kind).toContain("siku-siku");
          expect(page.text, kind).not.toContain("sikusiku");
        }
      },
      SLOW,
    );
  },
);

describe("a literal backslash-n stored in a step (S-10, rows stored before the fix)", () => {
  it(
    "is not printed in the PDF of the solutions",
    async () => {
      const step = String.raw`Kurangkan 3 dari kedua sisi:\n$$2x = 11 - 3$$\n$$2x = 8$$ lalu selesai`;
      const doc = buildDocumentModel(
        snapshot({}, { i1: version("Soal", "A", { steps: [step, "Langkah dua."] }) }),
        template,
      );
      const { bytes } = await renderForTest(doc, "solutions");
      const [page] = await readPages(bytes);
      expect(page.text).toContain("Kurangkan 3 dari kedua sisi:");
      expect(page.text).toContain("lalu selesai");
      expect(page.text).not.toContain(String.raw`\n`);
    },
    SLOW,
  );
});
