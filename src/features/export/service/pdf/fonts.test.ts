import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Font } from "@react-pdf/renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KATEX_FALLBACK } from "../../assets/fonts/katex-fallback.generated";
import { LIBERATION } from "../../assets/fonts/liberation.generated";
import {
  KATEX_AMS_FAMILY,
  KATEX_MAIN_FAMILY,
  KATEX_MATH_FAMILY,
  MONO_FAMILY,
  hyphenateLongWords,
  loadPdfFonts,
  pdfFontFamily,
  splitByCoverage,
  type FontStyle,
} from "./fonts";

const KATEX_DIR = join(process.cwd(), "node_modules", "katex", "dist", "fonts");
const FONTS_DIR = join(process.cwd(), "src", "features", "export", "assets", "fonts");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const LIBERATION_FAMILIES = [
  "LiberationSerif",
  "LiberationSerif-Bold",
  "LiberationSerif-Italic",
  "LiberationSerif-BoldItalic",
  "LiberationSans",
  "LiberationSans-Bold",
  "LiberationSans-Italic",
  "LiberationSans-BoldItalic",
];

beforeAll(loadPdfFonts);
afterEach(() => vi.restoreAllMocks());

describe("the generated KaTeX fonts", () => {
  it("match the installed katex package", () => {
    const { version } = JSON.parse(
      readFileSync(join(process.cwd(), "node_modules", "katex", "package.json"), "utf8"),
    ) as { version: string };
    expect(KATEX_FALLBACK.version).toBe(version);
    const files = {
      main: "KaTeX_Main-Regular.ttf",
      ams: "KaTeX_AMS-Regular.ttf",
      math: "KaTeX_Math-Italic.ttf",
    } as const;
    for (const key of Object.keys(files) as (keyof typeof files)[]) {
      const decoded = Buffer.from(KATEX_FALLBACK[key], "base64");
      expect(sha(decoded), key).toBe(sha(readFileSync(join(KATEX_DIR, files[key]))));
    }
  });
});

// The sha-256 of each TTF of Liberation 2.1.5 (from liberation-fonts-ttf-2.1.5.tar.gz, whose
// sha-256 is 7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0): swapping a TTF
// and regenerating the module fails here.
const LIBERATION_SHA256 = {
  serif: {
    regular: "058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74",
    bold: "d754ba427cfe0bca54ae052384baa8f842da5bd6550ad4da024ac441e7a7d5ce",
    italic: "0e3dea9f8d613e006ccfa62201f33e265d19167bd0907725c3e145368b04fc2e",
    boldItalic: "f17db8af71e24d2066b587546021d4f0b296be389512b658dec3c09affeb11a7",
  },
  sans: {
    regular: "76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8",
    bold: "788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173",
    italic: "e5bae5c4cde31f22142753855f4f8fb86da6ff39955ed3c0a11248b0d16948b0",
    boldItalic: "698da70fc191cc5f33ad4d6d3fe830fe4624b898ea2e3169955928b7c491f1ee",
  },
} as const;

describe("the generated Liberation fonts", () => {
  it("are the committed TTFs, byte for byte, and the pinned 2.1.5 files", () => {
    expect(LIBERATION.version).toBe("2.1.5");
    const names = { serif: "LiberationSerif", sans: "LiberationSans" } as const;
    const suffix = {
      regular: "Regular",
      bold: "Bold",
      italic: "Italic",
      boldItalic: "BoldItalic",
    } as const;
    for (const family of ["serif", "sans"] as const) {
      for (const face of ["regular", "bold", "italic", "boldItalic"] as const) {
        const committed = readFileSync(
          join(FONTS_DIR, `${names[family]}-${suffix[face]}.ttf`),
        );
        const decoded = Buffer.from(LIBERATION[family][face], "base64");
        expect(sha(committed), `${family} ${face} committed`).toBe(
          LIBERATION_SHA256[family][face],
        );
        expect(sha(decoded), `${family} ${face} generated`).toBe(
          LIBERATION_SHA256[family][face],
        );
      }
    }
  });

  it("ship with their licence text", () => {
    const licence = readFileSync(join(FONTS_DIR, "OFL.txt"), "utf8");
    expect(licence).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(licence).toContain("Copyright (c) 2012 Red Hat, Inc.");
    expect(licence).toContain("Reserved Font Name Liberation");
  });
});

describe("ensurePdfFonts", () => {
  it("registers the eleven data-URI fonts and the hyphenation callback once", async () => {
    vi.resetModules();
    const { ensurePdfFonts, loadPdfFonts: load } = await import("./fonts");
    const register = vi.spyOn(Font, "register").mockImplementation(() => undefined);
    const hyphenation = vi
      .spyOn(Font, "registerHyphenationCallback")
      .mockImplementation(() => undefined);
    await load();
    ensurePdfFonts();
    ensurePdfFonts();
    expect(register).toHaveBeenCalledTimes(11);
    const calls = register.mock.calls.map(
      ([options]) => options as { family: string; src: string },
    );
    expect(calls.map((options) => options.family).sort()).toEqual(
      [
        ...LIBERATION_FAMILIES,
        KATEX_AMS_FAMILY,
        KATEX_MAIN_FAMILY,
        KATEX_MATH_FAMILY,
      ].sort(),
    );
    for (const options of calls) {
      expect(options.src).toMatch(/^data:font\/ttf;base64,/);
    }
    expect(hyphenation).toHaveBeenCalledTimes(1);
  });

  it("refuses to register before the Liberation module is loaded", async () => {
    vi.resetModules();
    const { ensurePdfFonts } = await import("./fonts");
    expect(() => {
      ensurePdfFonts();
    }).toThrow("loadPdfFonts");
  });

  it("loadPdfFonts registers by itself, and only once", async () => {
    vi.resetModules();
    const { loadPdfFonts: load } = await import("./fonts");
    const register = vi.spyOn(Font, "register").mockImplementation(() => undefined);
    vi.spyOn(Font, "registerHyphenationCallback").mockImplementation(() => undefined);
    await load();
    await load();
    expect(register).toHaveBeenCalledTimes(11);
  });
});

describe("pdfFontFamily", () => {
  it("names the Liberation Serif faces for the times font", () => {
    expect(pdfFontFamily("times")).toBe("LiberationSerif");
    expect(pdfFontFamily("times", { bold: true })).toBe("LiberationSerif-Bold");
    expect(pdfFontFamily("times", { italic: true })).toBe("LiberationSerif-Italic");
    expect(pdfFontFamily("times", { bold: true, italic: true })).toBe(
      "LiberationSerif-BoldItalic",
    );
  });

  it("names the Liberation Sans faces for the arial font", () => {
    expect(pdfFontFamily("arial")).toBe("LiberationSans");
    expect(pdfFontFamily("arial", { bold: true })).toBe("LiberationSans-Bold");
    expect(pdfFontFamily("arial", { italic: true })).toBe("LiberationSans-Italic");
    expect(pdfFontFamily("arial", { bold: true, italic: true })).toBe(
      "LiberationSans-BoldItalic",
    );
  });

  it("uses Courier for the mono family", () => {
    expect(MONO_FAMILY).toBe("Courier");
  });
});

describe("hyphenateLongWords", () => {
  it("splits a 100-character word into chunks of at most 40", () => {
    const parts = hyphenateLongWords("a".repeat(100));
    expect(parts.join("")).toBe("a".repeat(100));
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(40);
  });

  it("leaves a normal word whole", () => {
    expect(hyphenateLongWords("pecahan")).toEqual(["pecahan"]);
    expect(hyphenateLongWords("a".repeat(40))).toEqual(["a".repeat(40)]);
  });

  it("never cuts a surrogate pair", () => {
    const parts = hyphenateLongWords("\u{1F600}".repeat(60));
    expect(parts.join("")).toBe("\u{1F600}".repeat(60));
    for (const part of parts) expect(part).toMatch(/^(?:\u{1F600})+$/u);
  });
});

describe("splitByCoverage", () => {
  const SYMBOLS = [
    "∠",
    "⊥",
    "∥",
    "△",
    "∈",
    "∉",
    "⊂",
    "∪",
    "∩",
    "→",
    "⇒",
    "≤",
    "≥",
    "≠",
    "π",
  ];

  it("keeps WinAnsi text in one base-font run", () => {
    expect(splitByCoverage("Luas segitiga, 5 × 3 ÷ 2 – “ok” €", "times")).toEqual([
      {
        kind: "text",
        family: "LiberationSerif",
        text: "Luas segitiga, 5 × 3 ÷ 2 – “ok” €",
      },
    ]);
    expect(splitByCoverage("", "times")).toEqual([]);
  });

  it("uses the requested base face for the plain text", () => {
    expect(splitByCoverage("ab", "arial", { bold: true })).toEqual([
      { kind: "text", family: "LiberationSans-Bold", text: "ab" },
    ]);
  });

  it("keeps Indonesian prose, accents, quotes and dashes in the base font", () => {
    const text =
      "Bapak membeli ½ kg apel seharga Rp 12.500,00 — “murah”, ‘enak’… café ñ ü °";
    expect(splitByCoverage(text, "times")).toEqual([
      { kind: "text", family: "LiberationSerif", text },
    ]);
    expect(splitByCoverage(text, "arial", { italic: true })).toEqual([
      { kind: "text", family: "LiberationSans-Italic", text },
    ]);
  });

  it.each(SYMBOLS)("draws %s with a font that really has it", (symbol) => {
    const runs = splitByCoverage(`a ${symbol} b`, "times");
    const run = runs.find((candidate) => candidate.text.includes(symbol));
    expect(run).toBeDefined();
    const family = run?.kind === "text" ? run.family : "box";
    expect([
      "LiberationSerif",
      KATEX_MAIN_FAMILY,
      KATEX_AMS_FAMILY,
      KATEX_MATH_FAMILY,
      "box",
    ]).toContain(family);
  });

  it("takes the symbols Liberation has from Liberation", () => {
    for (const symbol of ["≤", "≥", "≠", "π", "→", "∩", "∞", "√", "±"]) {
      expect(splitByCoverage(symbol, "times"), symbol).toEqual([
        { kind: "text", family: "LiberationSerif", text: symbol },
      ]);
      expect(splitByCoverage(symbol, "arial", { bold: true }), symbol).toEqual([
        { kind: "text", family: "LiberationSans-Bold", text: symbol },
      ]);
    }
  });

  it("falls back to the KaTeX font whose cmap has what Liberation lacks", () => {
    const family = (symbol: string) => {
      const run = splitByCoverage(symbol, "times")[0];
      return run.kind === "text" ? run.family : run.kind;
    };
    for (const symbol of ["∠", "⊥", "∥", "△", "∈", "⊂", "∪", "⇒"]) {
      expect(family(symbol), symbol).toBe(KATEX_MAIN_FAMILY);
    }
    expect(family("∴")).toBe(KATEX_AMS_FAMILY);
  });

  it("makes a glyph box for ∉, one per character", () => {
    expect(splitByCoverage("a∉b", "times")).toEqual([
      { kind: "text", family: "LiberationSerif", text: "a" },
      { kind: "box", text: "∉" },
      { kind: "text", family: "LiberationSerif", text: "b" },
    ]);
  });

  it("merges neighbours of the same font and keeps their order", () => {
    expect(splitByCoverage("x ∈ y ≤ z ⇒ w", "times")).toEqual([
      { kind: "text", family: "LiberationSerif", text: "x " },
      { kind: "text", family: KATEX_MAIN_FAMILY, text: "∈" },
      { kind: "text", family: "LiberationSerif", text: " y ≤ z " },
      { kind: "text", family: KATEX_MAIN_FAMILY, text: "⇒" },
      { kind: "text", family: "LiberationSerif", text: " w" },
    ]);
  });

  it("drops what no font can draw", () => {
    const hostile =
      "a\u0000b\u0007c\u200dd\ud800e\udc00f\u{1F600}g\u200bh\u202ei\ufeffj\u2060k\ufffdl\u0627m";
    expect(splitByCoverage(hostile, "times")).toEqual([
      { kind: "text", family: "LiberationSerif", text: "abcdefghijklm" },
    ]);
  });

  it("keeps a newline", () => {
    expect(splitByCoverage("a\nb", "times")).toEqual([
      { kind: "text", family: "LiberationSerif", text: "a\nb" },
    ]);
  });
});

describe("a real render", () => {
  async function render(font: "times" | "arial", text: string, style: FontStyle) {
    const { createElement } = await import("react");
    const { Document, Page, Text, renderToBuffer } = await import("@react-pdf/renderer");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const runs = splitByCoverage(text, font, style);
    const pdf = await renderToBuffer(
      createElement(
        Document,
        null,
        createElement(
          Page,
          { size: "A4" },
          ...runs.map((run, index) =>
            createElement(
              Text,
              {
                key: index,
                style: { fontSize: 12, fontFamily: (run as { family: string }).family },
              },
              run.text,
            ),
          ),
        ),
      ),
    );
    // yoga's WebAssembly start may fetch a data: URI; nothing else may be fetched.
    for (const [input] of fetchSpy.mock.calls) {
      expect(typeof input === "string" && input.startsWith("data:")).toBe(true);
    }
    return pdf.toString("latin1");
  }

  it("embeds Liberation Serif subsets for times, with the KaTeX fallback for ∈ ⇒", async () => {
    const text = await render("times", "Luas ≤ 5 π, x ∈ A ⇒ y", { bold: true });
    expect(text).toMatch(/\+LiberationSerif-Bold/);
    expect(text).toContain("FontFile2");
    expect(text).toContain("KaTeX_Main");
    expect(text).not.toContain("Times-Bold");
    expect(text).not.toContain("Helvetica");
  });

  it("embeds Liberation Sans subsets for arial", async () => {
    const text = await render("arial", "Luas segitiga", {});
    expect(text).toMatch(/\+LiberationSans/);
    expect(text).toContain("FontFile2");
    expect(text).not.toContain("Helvetica");
  });
});

describe("the generator", () => {
  const script = pathToFileURL(
    join(process.cwd(), "scripts", "generate-pdf-fonts.mjs"),
  ).href;

  it("regenerates the committed KaTeX module byte for byte", async () => {
    const committed = readFileSync(
      join(FONTS_DIR, "katex-fallback.generated.ts"),
      "utf8",
    );
    const { generateFontsModule } = (await import(script)) as {
      generateFontsModule: (root: string) => string;
    };
    expect(generateFontsModule(process.cwd())).toBe(committed);
  });

  it("regenerates the committed Liberation module byte for byte", async () => {
    const committed = readFileSync(join(FONTS_DIR, "liberation.generated.ts"), "utf8");
    const { generateLiberationModule } = (await import(script)) as {
      generateLiberationModule: (root: string) => string;
    };
    expect(generateLiberationModule(process.cwd())).toBe(committed);
  });
});

describe("ensurePdfFonts after a failure", () => {
  it("registers again on the next call when a registration threw", async () => {
    vi.resetModules();
    const { ensurePdfFonts, loadPdfFonts: load } = await import("./fonts");
    const register = vi.spyOn(Font, "register").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    vi.spyOn(Font, "registerHyphenationCallback").mockImplementation(() => undefined);
    await expect(load()).rejects.toThrow("boom");
    register.mockImplementation(() => undefined);
    ensurePdfFonts();
    expect(register).toHaveBeenCalledTimes(12);
    ensurePdfFonts();
    expect(register).toHaveBeenCalledTimes(12);
  });
});

describe("splitByCoverage text normalisation", () => {
  it("maps a tab to a space", () => {
    expect(splitByCoverage("a\tb", "times")).toEqual([
      { kind: "text", family: "LiberationSerif", text: "a b" },
    ]);
  });

  it("composes combining marks so accents are kept", () => {
    expect(splitByCoverage("é ñ", "times")).toEqual([
      { kind: "text", family: "LiberationSerif", text: "é ñ" },
    ]);
  });
});

describe("hyphenateLongWords unit", () => {
  it("cuts by 40 code points whatever their width", () => {
    // A cut by count, not by width: the layout also breaks overwide words by estimated width.
    expect(hyphenateLongWords("W".repeat(41)).map((part) => part.length)).toEqual([
      40, 1,
    ]);
  });
});
