import { describe, expect, it } from "vitest";
import { buildDocumentModel, type ExportVersion } from "./document-model";
import { snapshot, template, version } from "../test-support";
import { renderDocument, renderHtml } from "./render-html";

const build = (
  overrides = {},
  versions: Record<string, ExportVersion> = {},
  tpl = template,
  logo?: { bytes: Uint8Array; contentType: string },
) => buildDocumentModel(snapshot(overrides, versions), tpl, { logo: logo ?? null });
const opts = { paper: "A4", font: "times" } as const;
const labelled = (texts: string[]) =>
  texts.map((textMd, i) => ({ label: (["A", "B", "C", "D"] as const)[i], textMd }));

describe("renderHtml structure", () => {
  it("renders the paper with letterhead, fields, instructions, sections and items", () => {
    const html = renderHtml(build(), "paper", opts);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('lang="id"');
    expect(html).toContain("SMP Negeri 1 Contoh");
    expect(html).toContain("Naskah Soal");
    expect(html).toContain("Nama");
    expect(html).toContain("Kelas");
    expect(html).toContain("Berdoalah dahulu.");
    expect(html).toContain("A. Pilihan ganda");
    expect(html).toContain("Pilih satu jawaban.");
    expect(html).toContain("Soal i3");
    expect(html).toContain("Pilihan D");
    expect(html).toContain("90 menit");
    expect(html).toContain("Selasa, 17 November 2026");
    // The letterhead: lines before the school name.
    expect(html.indexOf("DINAS PENDIDIKAN")).toBeLessThan(
      html.indexOf("SMP Negeri 1 Contoh"),
    );
  });

  it("puts break-inside: avoid on every item", () => {
    const html = renderHtml(build(), "paper", opts);
    expect(html).toMatch(/\.item\s*\{[^}]*break-inside:\s*avoid/);
    expect((html.match(/class="item"/g) ?? []).length).toBe(5);
  });

  it("sets the A4 and F4 page sizes", () => {
    const a4 = renderHtml(build(), "paper", { paper: "A4", font: "times" });
    const f4 = renderHtml(build(), "paper", { paper: "F4", font: "times" });
    expect(a4).toContain("size: 210mm 297mm");
    expect(a4).not.toContain("215mm 330mm");
    expect(f4).toContain("size: 215mm 330mm");
    expect(f4).not.toContain("210mm 297mm");
    expect(f4).toContain('data-paper="F4"');
  });

  it("sets Times New Roman 12 or Arial 12 stacks with Liberation fallbacks", () => {
    const times = renderHtml(build(), "paper", { paper: "A4", font: "times" });
    const arial = renderHtml(build(), "paper", { paper: "A4", font: "arial" });
    expect(times).toMatch(/font-family:\s*"Times New Roman", "Liberation Serif"/);
    expect(arial).toMatch(/font-family:\s*Arial, "Liberation Sans"/);
    expect(times).toMatch(/font-size:\s*12pt/);
    expect(arial).toMatch(/font-size:\s*12pt/);
  });

  it("adds the page footer through CSS counters and a data attribute", () => {
    const html = renderHtml(build(), "paper", opts);
    expect(html).toContain("counter(page)");
    expect(html).toContain("counter(pages)");
    expect(html).toContain("Halaman ");
    expect(html).toContain('data-footer="Halaman {page} dari {pages}"');
  });

  it("lays options out in the model's columns", () => {
    const html = renderHtml(
      build(
        {},
        {
          i1: version("s", "A", { options: labelled(["10", "11", "12", "13"]) }),
          i2: version("t", "A", {
            options: labelled(["x".repeat(20), "y".repeat(20), "z", "w"]),
          }),
          i3: version("u", "A", {
            options: labelled(["x".repeat(50), "y", "z", "w"]),
          }),
        },
      ),
      "paper",
      opts,
    );
    expect(html).toContain('class="options cols-4"');
    expect(html).toContain('class="options cols-2"');
    expect(html).toContain('class="options cols-1"');
  });
});

describe("key and solutions", () => {
  it("key: a No / Jawaban / Skor table that matches the paper numbering with shuffle", () => {
    const doc = build({ shuffleSeed: 424242 });
    const html = renderHtml(doc, "key", opts);
    expect(html).toContain("Kunci Jawaban");
    expect(html).toMatch(
      /<th[^>]*>No<\/th>\s*<th[^>]*>Jawaban<\/th>\s*<th[^>]*>Skor<\/th>/,
    );
    const rows = [
      ...html.matchAll(
        /<tr class="key-row"><td>(\d+)<\/td><td>([A-D])<\/td><td>([\d,]+)<\/td><\/tr>/g,
      ),
    ];
    const paper = doc.sections.flatMap((s) => s.items);
    expect(rows.map((r) => Number(r[1]))).toEqual(paper.map((i) => i.number));
    const answerOf: Record<string, string> = {
      i1: "A",
      i2: "B",
      i3: "C",
      i4: "D",
      i5: "A",
    };
    expect(rows.map((r) => r[2])).toEqual(paper.map((i) => answerOf[i.itemId]));
    expect(rows[0][3]).toBe("20");
    expect(html).toContain("Total");
    expect(html).not.toContain("Nama"); // no student fields on the key
  });

  it("solutions: shows the steps", () => {
    const html = renderHtml(build(), "solutions", opts);
    expect(html).toContain("Pembahasan");
    expect(html).toContain("Langkah satu.");
    expect(html).toContain("Langkah dua.");
    expect(html).toContain("Jawaban: B");
    expect(renderHtml(build(), "paper", opts)).not.toContain("Langkah satu.");
  });
});

describe("self-contained and safe", () => {
  const stuff = [
    "Hitung $\\frac{1}{2}+\\sqrt{\\frac{3}{4}}$",
    "$$\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$$",
  ].join("\n\n");
  const logo = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" };

  it("contains no http(s) URL anywhere (math, SVG roots, fonts, logo)", () => {
    for (const kind of ["paper", "key", "solutions"] as const) {
      const html = renderHtml(
        build(
          {},
          {
            i1: version(stuff, "A", {
              steps: [stuff, "$\\sqrt{x^{2}+\\frac{1}{\\frac{1}{x}}}$"],
            }),
          },
          template,
          logo,
        ),
        kind,
        opts,
      );
      expect(html).not.toMatch(/https?:/i);
      expect(html).not.toMatch(/\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    }
  });

  it("inlines the KaTeX fonts as data URIs when math is present, and none otherwise", () => {
    const withMath = renderHtml(build({}, { i1: version("$x^2$") }), "paper", opts);
    expect(withMath).toContain("@font-face");
    expect(withMath).toMatch(/url\(data:font\/woff2;base64,/);
    expect(withMath).not.toMatch(/url\((?!data:)/);
    expect(withMath).not.toContain(".woff)");
    expect(withMath).not.toContain(".ttf");
    const plain = renderHtml(build(), "paper", opts);
    expect(plain).not.toContain("@font-face");
  });

  it("has the CSP meta and no scripts, links, iframes or event handlers", () => {
    const html = renderHtml(build({}, {}, template, logo), "paper", opts);
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`,
    );
    expect(html).not.toMatch(/<script|<link|<iframe|<object|<embed|<base|javascript:/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).toContain('<img class="logo" src="data:image/png;base64,AQID" alt="">');
  });

  it("escapes hostile stems, options, titles, headers and steps", () => {
    const hostile =
      '<script>alert(1)</script><img src=x onerror=alert(1)></style><b onmouseover="x">';
    const tpl = { ...template, schoolName: hostile, headerLines: [hostile] };
    const doc = buildDocumentModel(
      snapshot(
        { title: hostile, instructionsMd: hostile },
        {
          i1: version(hostile, "A", {
            options: labelled([hostile, "b"]),
            steps: [hostile, hostile],
          }),
        },
      ),
      tpl,
    );
    for (const kind of ["paper", "key", "solutions"] as const) {
      const html = renderHtml(doc, kind, opts);
      expect(html).not.toContain("<script");
      expect(html).not.toMatch(/<img[^>]*onerror/i);
      expect(html).not.toMatch(/<b onmouseover/i);
      expect(html.match(/<\/style>/g)?.length).toBe(html.match(/<style>/g)?.length);
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    }
  });

  it("escapes a hostile section title, subject and the solutions answer text", () => {
    const hostile = '<script>x</script><img src=x onerror=alert(1)>"';
    const doc = buildDocumentModel(
      snapshot({}, { i1: version("s", "A", { options: labelled([hostile, "b"]) }) }),
      { ...template, subject: hostile },
    );
    doc.sections[0].title = hostile;
    for (const kind of ["paper", "key", "solutions"] as const) {
      const html = renderHtml(doc, kind, opts);
      expect(html).not.toContain("<script");
      expect(html).not.toMatch(/<img[^>]*onerror/i);
    }
    expect(renderHtml(doc, "solutions", opts)).toContain("Jawaban: A. &lt;script&gt;");
  });

  it("labels each formula with its LaTeX source for screen readers", () => {
    const html = renderHtml(
      build({}, { i1: version('Hitung $x^2$ dan $$\\frac{1}{2}$$ "q"') }),
      "paper",
      opts,
    );
    expect(html).toContain('<span class="math" role="img" aria-label="x^2">');
    expect(html).toContain('aria-label="\\frac{1}{2}"');
    const hostile = renderHtml(
      build({}, { i1: version('$\\text{" onload="x}$') }),
      "paper",
      opts,
    );
    expect(hostile).not.toMatch(/aria-label="[^"]*"\s+onload/);
  });

  it("escapes hostile text inside a failing math span too", () => {
    const { html, warnings } = renderDocument(
      build({}, { i1: version("$\\badcommand<script>x</script>$") }),
      "paper",
      opts,
    );
    expect(html).not.toContain("<script");
    expect(html).toContain("\\badcommand&lt;script&gt;");
    expect(warnings).toHaveLength(1);
  });
});

describe("math", () => {
  it("renders a long nested-fraction stem and a matrix without throwing", () => {
    let nested = "x";
    for (let i = 0; i < 12; i += 1) {
      nested = `\\frac{1+${nested}}{${String(i + 2)}+\\frac{1}{${nested}}}`;
    }
    const stem = `Sederhanakan $${nested}$ lalu hitung\n\n$$\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}\\begin{bmatrix} 1 \\\\ 2 \\end{bmatrix}$$`;
    const { html, warnings } = renderDocument(
      build({}, { i1: version(stem) }),
      "paper",
      opts,
    );
    expect(warnings).toEqual([]);
    expect(html).toContain('class="katex"');
    expect(html).toContain("katex-display");
  });

  it("falls back to the plain source and reports a warning on a KaTeX failure", () => {
    const { html, warnings } = renderDocument(
      build({}, { i1: version("Hitung $\\frac{1}{$ sekarang") }),
      "paper",
      opts,
    );
    expect(html).toContain("$\\frac{1}{$");
    expect(warnings).toEqual([
      { code: "mathFailed", where: { part: "stem", number: 1 }, source: "\\frac{1}{" },
    ]);
  });

  it("prints a display formula at full size when it fits the column, with no warning", () => {
    const { html, warnings } = renderDocument(
      build({}, { i1: version("$$x^2 + 2x + 1 = 0$$") }),
      "paper",
      opts,
    );
    expect(html).toContain('<div class="math-block">');
    expect(warnings).toEqual([]);
  });

  it("shrinks a display formula a little wider than the column, with no warning", () => {
    const wide = Array.from({ length: 14 }, (_, i) => `x_{${String(i)}}`).join(" + ");
    const { html, warnings } = renderDocument(
      build({}, { i1: version(`$$${wide} = 0$$`) }),
      "paper",
      opts,
    );
    expect(html).toMatch(/<div class="math-block fit-(90|80|70)">/);
    expect(warnings).toEqual([]);
  });

  it("shrinks a formula far wider than the column to the smallest size and warns", () => {
    const tooWide = Array.from({ length: 40 }, (_, i) => `a_{${String(i)}}`).join(" + ");
    const { html, warnings } = renderDocument(
      build({}, { i1: version(`Hitung\n\n$$${tooWide} = 0$$`) }),
      "paper",
      opts,
    );
    expect(html).toContain('<div class="math-block fit-70">');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "mathTooWide",
      where: { part: "stem", number: 1 },
    });
    expect(warnings[0].source.startsWith("a_{0} + a_{1}")).toBe(true);
  });

  it("never clips a display formula in print: no hidden overflow, and the fit sizes exist", () => {
    const html = renderHtml(build(), "paper", opts);
    expect(html).not.toMatch(/\.math-block\s*\{[^}]*overflow:\s*hidden/);
    for (const size of ["90", "80", "70"]) {
      expect(html).toContain(`.math-block.fit-${size} { font-size: ${size}%; }`);
    }
  });

  it("writes a decimal comma in math the way the web does", () => {
    const html = renderHtml(build({}, { i1: version("$9,60$") }), "paper", opts);
    // The grouped comma `{,}` has no thin space after it (a bare comma would add one).
    expect(html).toContain('<span class="mord"><span class="mpunct">,</span></span>');
    expect(html).not.toContain('<span class="mpunct">,</span><span class="mspace"');
  });

  it("shows unit exponents outside math as superscripts", () => {
    const html = renderHtml(build({}, { i1: version("Luas 24 cm^2") }), "paper", opts);
    expect(html).toContain("cm<sup>2</sup>");
  });
});

describe("text subset", () => {
  it("makes paragraphs, line breaks, bold and italic", () => {
    const html = renderHtml(
      build({}, { i1: version("Satu\nDua\n\n**tebal** dan *miring*") }),
      "paper",
      opts,
    );
    expect(html).toContain("<p>Satu<br>Dua</p>");
    expect(html).toContain("<p><strong>tebal</strong> dan <em>miring</em></p>");
  });
});

describe("typographic characters (S-01 audit)", () => {
  it("keeps the non-breaking hyphen, dashes, quotes and spaces as written", () => {
    const prose =
      "siku\u2011siku 1\u20132 a\u2014b \u201cq\u201d 8\u00a0cm 8\u202fcm \u22123";
    const html = renderHtml(build({}, { i1: version(prose) }), "paper", opts);
    expect(html).toContain(prose);
  });
});
