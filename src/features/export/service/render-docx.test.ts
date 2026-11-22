import { createCanvas } from "@napi-rs/canvas";
import JSZip from "jszip";
import { SaxesParser } from "saxes";
import { describe, expect, it, vi } from "vitest";
import { snapshot, template, version } from "../test-support";
import { buildDocumentModel, type ExportVersion } from "./document-model";
import { Document, Packer, Paragraph } from "docx";
import {
  assertDocxWellFormed,
  ommlComponent,
  RenderDocxError,
  renderDocx,
  renderDocxDocument,
} from "./render-docx";

interface Logo {
  bytes: Uint8Array;
  contentType: string;
}
const build = (
  overrides = {},
  versions: Record<string, ExportVersion> = {},
  tpl = template,
  logo: Logo | null = null,
) => buildDocumentModel(snapshot(overrides, versions), tpl, { logo });
const A4 = { paper: "A4", font: "times" } as const;
const labelled = (texts: string[]) =>
  texts.map((textMd, i) => ({ label: (["A", "B", "C", "D"] as const)[i], textMd }));

async function unzip(bytes: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(bytes);
}

async function part(bytes: Uint8Array, name: string): Promise<string> {
  const file = (await unzip(bytes)).file(name);
  if (!file) throw new Error(`missing part ${name}`);
  return file.async("string");
}

/** Throws when the XML is not well-formed XML 1.0. */
function assertWellFormed(xml: string): void {
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", (error) => {
    throw error;
  });
  parser.write(xml).close();
}

/** The decoded text of every w:t, in order. */
function wordText(xml: string): string[] {
  const texts: string[] = [];
  let inText = false;
  let current = "";
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    if (tag.name === "w:t") {
      inText = true;
      current = "";
    }
  });
  parser.on("text", (text) => {
    if (inText) current += text;
  });
  parser.on("closetag", (tag) => {
    if (tag.name === "w:t") {
      inText = false;
      texts.push(current);
    }
  });
  parser.write(xml).close();
  return texts;
}

const count = (xml: string, pattern: RegExp) => (xml.match(pattern) ?? []).length;

function png(width: number, height: number): Uint8Array {
  return new Uint8Array(createCanvas(width, height).toBuffer("image/png"));
}
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array(createCanvas(width, height).toBuffer("image/jpeg"));
}

describe("renderDocx package", () => {
  it("is a zip with the parts Word needs", async () => {
    const bytes = await renderDocx(build(), "paper", A4);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
    const zip = await unzip(bytes);
    for (const name of [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/styles.xml",
      "word/_rels/document.xml.rels",
      "docProps/core.xml",
    ]) {
      expect(zip.file(name), name).not.toBeNull();
    }
    for (const name of Object.keys(zip.files)) {
      if (name.endsWith(".xml") || name.endsWith(".rels")) {
        assertWellFormed(await zip.file(name)!.async("string"));
      }
    }
  });

  it("has no macros, no external relationships and no remote URL targets", async () => {
    const zip = await unzip(await renderDocx(build(), "paper", A4));
    const names = Object.keys(zip.files);
    expect(names.some((n) => /vbaProject|\.bin$|macro/i.test(n))).toBe(false);
    const types = await zip.file("[Content_Types].xml")!.async("string");
    expect(types).not.toMatch(/macroEnabled|vbaProject/i);
    for (const name of names.filter((n) => n.endsWith(".rels"))) {
      const rels = await zip.file(name)!.async("string");
      expect(rels, name).not.toContain('TargetMode="External"');
    }
  });

  it("sets document properties without personal data", async () => {
    const core = await part(await renderDocx(build(), "paper", A4), "docProps/core.xml");
    expect(core).toContain("<dc:title>Naskah Soal - Ulangan Bab 1</dc:title>");
    expect(core).toContain("<dc:creator>MitraMatika</dc:creator>");
    expect(core).toContain("<cp:lastModifiedBy>MitraMatika</cp:lastModifiedBy>");
    expect(core).not.toContain("Un-named");
  });
});

describe("renderDocx page and font", () => {
  it("sets the A4 page size in twips", async () => {
    const xml = await part(await renderDocx(build(), "paper", A4), "word/document.xml");
    expect(xml).toMatch(/<w:pgSz w:w="11906" w:h="16838"/);
  });

  it("sets the F4 page size in twips", async () => {
    const xml = await part(
      await renderDocx(build(), "paper", { paper: "F4", font: "times" }),
      "word/document.xml",
    );
    expect(xml).toMatch(/<w:pgSz w:w="12189" w:h="18709"/);
    expect(xml).not.toContain('w:w="11906"');
  });

  it("names Times New Roman on every text run", async () => {
    const xml = await part(await renderDocx(build(), "paper", A4), "word/document.xml");
    const runs = xml.match(/<w:r>[\s\S]*?<\/w:r>/g) ?? [];
    expect(runs.length).toBeGreaterThan(20);
    for (const run of runs) {
      expect(run).toContain(
        '<w:rFonts w:ascii="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman" w:hAnsi="Times New Roman"/>',
      );
    }
    expect(xml).not.toContain("Arial");
  });

  it("names Arial when the template says so, at 12 pt", async () => {
    const bytes = await renderDocx(build(), "paper", { paper: "A4", font: "arial" });
    const xml = await part(bytes, "word/document.xml");
    expect(xml).toContain('w:ascii="Arial"');
    expect(xml).not.toContain("Times New Roman");
    const styles = await part(bytes, "word/styles.xml");
    expect(styles).toMatch(
      /<w:docDefaults>[\s\S]*w:ascii="Arial"[\s\S]*<w:sz w:val="24"\/>/,
    );
  });

  it("puts 'Halaman x dari y' with PAGE and NUMPAGES fields in the footer", async () => {
    const zip = await unzip(await renderDocx(build(), "paper", A4));
    const footers = Object.keys(zip.files).filter((n) =>
      /^word\/footer\d*\.xml$/.test(n),
    );
    expect(footers).toHaveLength(1);
    const footer = await zip.file(footers[0])!.async("string");
    expect(wordText(footer).join("")).toContain("Halaman ");
    expect(wordText(footer).join("")).toContain(" dari ");
    expect(footer).toMatch(/<w:instrText[^>]*>\s*PAGE\s*<\/w:instrText>/);
    expect(footer).toMatch(/<w:instrText[^>]*>\s*NUMPAGES\s*<\/w:instrText>/);
  });
});

describe("renderDocx paper", () => {
  it("prints the letterhead lines before the school name, then title and student fields", async () => {
    const xml = await part(await renderDocx(build(), "paper", A4), "word/document.xml");
    const text = wordText(xml).join("\n");
    for (const line of template.headerLines) expect(text).toContain(line);
    expect(text.indexOf("DINAS PENDIDIKAN")).toBeLessThan(
      text.indexOf("SMP Negeri 1 Contoh"),
    );
    expect(text.indexOf("SMP Negeri 1 Contoh")).toBeLessThan(text.indexOf("NASKAH SOAL"));
    expect(text).toContain("Nama");
    expect(text).toContain("Kelas");
    expect(text).toContain("Berdoalah dahulu.");
    expect(text).toContain("Selasa, 17 November 2026");
    expect(text).toContain("90 menit");
    expect(text).toContain("A. Pilihan ganda");
    expect(text).toContain("Pilih satu jawaban.");
  });

  it("numbers the questions and prints options A-D", async () => {
    const xml = await part(await renderDocx(build(), "paper", A4), "word/document.xml");
    const text = wordText(xml);
    for (const n of [1, 2, 3, 4, 5]) expect(text).toContain(`${String(n)}.`);
    for (const id of ["i1", "i2", "i3", "i4", "i5"])
      expect(text.join("\n")).toContain(`Soal ${id}`);
    for (const label of ["A.", "B.", "C.", "D."]) expect(text).toContain(label);
  });

  it("prints shuffled numbering in the model's order", async () => {
    const doc = build({ shuffleSeed: 42 });
    const order = doc.sections
      .flatMap((s) => s.items)
      .sort((a, b) => a.number - b.number);
    const xml = await part(await renderDocx(doc, "paper", A4), "word/document.xml");
    const text = wordText(xml).join("\n");
    const positions = order.map((item) => text.indexOf(item.stemMd));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("keeps a question together: keepNext and keepLines on its paragraphs", async () => {
    const xml = await part(await renderDocx(build(), "paper", A4), "word/document.xml");
    const stem =
      /<w:p>(?:(?!<\/w:p>)[\s\S])*Soal i1(?:(?!<\/w:p>)[\s\S])*<\/w:p>/.exec(xml)?.[0] ??
      "";
    expect(stem).toContain("<w:keepNext/>");
    expect(stem).toContain("<w:keepLines/>");
    expect(count(xml, /<w:cantSplit\/>/g)).toBeGreaterThan(0);
  });

  it("lays options out in 4, 2 or 1 columns without borders", async () => {
    const xml4 = await part(await renderDocx(build(), "paper", A4), "word/document.xml");
    // Short options: one row of four cells.
    expect(xml4).toMatch(/<w:tblGrid>(?:<w:gridCol w:w="\d+"\/>){4}<\/w:tblGrid>/);
    expect(xml4).toMatch(/<w:tblBorders>[\s\S]*?<w:top w:val="none"/);

    const medium = labelled([
      "Dua puluh lima",
      "Tiga puluh enam",
      "Empat puluh",
      "Lima puluh",
    ]);
    const two = build({}, { i1: version("Soal dua kolom", "A", { options: medium }) });
    const xml2 = await part(await renderDocx(two, "paper", A4), "word/document.xml");
    expect(xml2).toMatch(/<w:tblGrid>(?:<w:gridCol w:w="\d+"\/>){2}<\/w:tblGrid>/);

    const long = labelled([
      "Sebuah pilihan yang sangat panjang sekali untuk dibaca",
      "Pilihan kedua yang juga panjang sekali untuk dibaca",
      "Pilihan ketiga yang juga panjang sekali untuk dibaca",
      "Pilihan keempat yang juga panjang sekali untuk dibaca",
    ]);
    const one = build(
      {},
      Object.fromEntries(
        ["i1", "i2", "i3", "i4", "i5"].map((id) => [
          id,
          version(`Soal ${id}`, "A", { options: long }),
        ]),
      ),
    );
    const xml1 = await part(await renderDocx(one, "paper", A4), "word/document.xml");
    expect(wordText(xml1)).toContain("A.");
    // Only the letterhead's three-column table, no 2- or 4-column option table.
    expect(xml1).not.toMatch(
      /<w:tblGrid>(?:(?:<w:gridCol w:w="\d+"\/>){2}|(?:<w:gridCol w:w="\d+"\/>){4})<\/w:tblGrid>/,
    );
  });

  it("maps paragraphs, line breaks, bold and italic to runs", async () => {
    const stem = "Baris satu\nbaris dua\n\n**Tebal** dan *miring* dan luas 24 cm^2.";
    const xml = await part(
      await renderDocx(build({}, { i1: version(stem) }), "paper", A4),
      "word/document.xml",
    );
    // Within one run (no </w:r> in between).
    const inRun = "(?:(?!</w:r>)[\\s\\S])*?";
    expect(xml).toMatch(new RegExp(`<w:r><w:rPr>${inRun}<w:b/>${inRun}>Tebal</w:t>`));
    expect(xml).toMatch(new RegExp(`<w:r><w:rPr>${inRun}<w:i/>${inRun}>miring</w:t>`));
    expect(xml).toMatch(new RegExp(`<w:vertAlign w:val="superscript"/>${inRun}>2</w:t>`));
    // The line break is a run of its own, right before "baris dua" in the same paragraph.
    expect(xml).toMatch(
      new RegExp(
        `>Baris satu</w:t></w:r><w:r><w:rPr>${inRun}<w:br/>${inRun}</w:r><w:r>${inRun}>baris dua</w:t>`,
      ),
    );
    // Plain runs are neither bold nor italic.
    expect(xml).not.toMatch(new RegExp(`<w:r><w:rPr>${inRun}<w:b/>${inRun}> dan </w:t>`));
    const text = wordText(xml);
    expect(text).not.toContain("**Tebal**");
    // Two paragraphs: "Baris satu ... baris dua" and the bold one are in different w:p.
    const para =
      /<w:p>(?:(?!<\/w:p>)[\s\S])*baris dua(?:(?!<\/w:p>)[\s\S])*<\/w:p>/.exec(
        xml,
      )?.[0] ?? "";
    expect(para).not.toContain("Tebal");
  });
});

describe("renderDocx math", () => {
  it("writes one native m:oMath per formula", async () => {
    const stem =
      "Hitung $\\frac{a}{b}$ dan $\\sqrt{x}$ serta $x^2$, $a_1 \\le 3 \\times 2$.";
    const options = labelled(["$\\frac{1}{2}$", "$2$", "$3$", "$4$"]);
    const doc = build({}, { i1: version(stem, "A", { options }) });
    const xml = await part(await renderDocx(doc, "paper", A4), "word/document.xml");
    assertWellFormed(xml);
    expect(count(xml, /<m:oMath>/g) + count(xml, /<m:oMath /g)).toBe(8);
    expect(xml).toContain("<m:f>");
    expect(xml).toContain("<m:rad>");
    expect(xml).toContain("<m:sSup>");
    expect(xml).toContain("<m:sSub>");
    expect(xml).toMatch(/<m:t[^>]*>[^<]*≤/);
    expect(xml).toMatch(/<m:t[^>]*>[^<]*×/);
    // Inline: the formula sits inside the stem paragraph, between the words.
    expect(xml).toMatch(/Hitung <\/w:t><\/w:r><m:oMath/);
  });

  it("writes display math as its own m:oMathPara", async () => {
    const stem = "Perhatikan:\n\n$$\\frac{x+1}{2} = 3$$\n\nTentukan x.";
    const xml = await part(
      await renderDocx(build({}, { i1: version(stem) }), "paper", A4),
      "word/document.xml",
    );
    expect(count(xml, /<m:oMathPara>/g)).toBe(1);
    expect(xml).toMatch(/<m:oMathPara><m:oMath>[\s\S]*<m:f>/);
  });

  it("uses the decimal comma like the preview", async () => {
    const xml = await part(
      await renderDocx(build({}, { i1: version("Nilai $9,60$") }), "paper", A4),
      "word/document.xml",
    );
    expect(xml).toMatch(/<m:t[^>]*>9,60<\/m:t>/);
  });

  it("falls back to monospace text and a warning for an unsupported command", async () => {
    const doc = build({}, { i2: version("Soal $\\unknowncmd{x}$ akhir") });
    const { bytes, warnings } = await renderDocxDocument(doc, "paper", A4);
    const xml = await part(bytes, "word/document.xml");
    expect(warnings).toEqual([
      {
        code: "mathFailed",
        where: { part: "stem", number: 2 },
        source: "\\unknowncmd{x}",
      },
    ]);
    const fallback =
      /<w:r>(?:(?!<\/w:r>)[\s\S])*\$\\unknowncmd\{x\}\$(?:(?!<\/w:r>)[\s\S])*<\/w:r>/.exec(
        xml,
      )?.[0];
    expect(fallback).toBeDefined();
    expect(fallback).toContain('w:ascii="Courier New"');
    expect(count(xml, /<m:oMath/g)).toBe(0);
  });

  it("records where option and step formulas failed", async () => {
    const options = labelled(["$\\bad$", "B", "C", "D"]);
    const doc = build(
      {},
      { i1: version("Soal", "A", { options, steps: ["Langkah $\\worse$"] }) },
    );
    const paper = await renderDocxDocument(doc, "paper", A4);
    expect(paper.warnings).toContainEqual({
      code: "mathFailed",
      where: { part: "option", number: 1, label: "A" },
      source: "\\bad",
    });
    const solutions = await renderDocxDocument(doc, "solutions", A4);
    expect(solutions.warnings).toContainEqual({
      code: "mathFailed",
      where: { part: "step", number: 1, step: 1 },
      source: "\\worse",
    });
  });
});

describe("renderDocx key and solutions", () => {
  it("prints the key as a No / Jawaban / Skor table in paper order with a total", async () => {
    const doc = build({ shuffleSeed: 7, scoringMode: "equal" });
    const xml = await part(await renderDocx(doc, "key", A4), "word/document.xml");
    const text = wordText(xml);
    expect(text).toContain("KUNCI JAWABAN");
    const start = text.indexOf("No");
    expect(text.slice(start, start + 3)).toEqual(["No", "Jawaban", "Skor"]);
    const rows = doc.sections.flatMap((s) => s.items).sort((a, b) => a.number - b.number);
    const body = text.slice(start + 3, start + 3 + rows.length * 3);
    expect(body).toEqual(
      rows.flatMap((r) => [
        String(r.number),
        r.answerMd,
        String(r.points).replace(".", ","),
      ]),
    );
    expect(text).toContain("Total");
    expect(xml).toContain("<w:tblHeader/>");
    expect(text).not.toContain("Nama");
    expect(text.join(" ")).not.toContain("Soal i1");
  });

  it("prints solutions with the answer and numbered steps", async () => {
    const xml = await part(
      await renderDocx(build(), "solutions", A4),
      "word/document.xml",
    );
    const text = wordText(xml).join("");
    expect(text).toContain("PEMBAHASAN");
    expect(text).toContain("Soal i1");
    expect(text).toContain("Jawaban: A. Pilihan A");
    expect(text).toContain("1) Langkah satu.");
    expect(text).toContain("2) Langkah dua.");
  });
});

describe("renderDocx logo", () => {
  it("embeds a PNG logo as media with its aspect ratio", async () => {
    const doc = build(
      {},
      {},
      { ...template, hasLogo: true },
      { bytes: png(200, 100), contentType: "image/png" },
    );
    const { bytes, warnings } = await renderDocxDocument(doc, "paper", A4);
    expect(warnings).toEqual([]);
    const zip = await unzip(bytes);
    const media = Object.keys(zip.files).filter(
      (n) => n.startsWith("word/media/") && !n.endsWith("/"),
    );
    expect(media).toHaveLength(1);
    expect(media[0]).toMatch(/\.png$/);
    const xml = await zip.file("word/document.xml")!.async("string");
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(xml);
    expect(extent).not.toBeNull();
    expect(Number(extent![1]) / Number(extent![2])).toBeCloseTo(2, 1);
    // The logo comes before the first header line.
    expect(xml.indexOf("<w:drawing>")).toBeLessThan(
      xml.indexOf("PEMERINTAH KOTA CONTOH"),
    );
  });

  it("embeds a JPEG logo", async () => {
    const doc = build({}, {}, template, {
      bytes: jpeg(80, 160),
      contentType: "image/jpeg",
    });
    const zip = await unzip(await renderDocx(doc, "paper", A4));
    const media = Object.keys(zip.files).filter(
      (n) => n.startsWith("word/media/") && !n.endsWith("/"),
    );
    expect(media).toHaveLength(1);
    const xml = await zip.file("word/document.xml")!.async("string");
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(xml);
    expect(Number(extent![1]) / Number(extent![2])).toBeCloseTo(0.5, 1);
  });

  it("omits an SVG logo with a warning (no raster fallback available)", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="5"/></svg>';
    const doc = build({}, {}, template, {
      bytes: new TextEncoder().encode(svg),
      contentType: "image/svg+xml",
    });
    const { bytes, warnings } = await renderDocxDocument(doc, "paper", A4);
    expect(warnings).toEqual([
      { code: "logoOmitted", where: { part: "letterhead" }, source: "image/svg+xml" },
    ]);
    const zip = await unzip(bytes);
    expect(
      Object.keys(zip.files).some((n) => n.startsWith("word/media/") && !n.endsWith("/")),
    ).toBe(false);
    expect(await zip.file("word/document.xml")!.async("string")).toContain(
      "SMP Negeri 1 Contoh",
    );
  });

  it("omits a logo whose bytes are not a readable PNG/JPEG", async () => {
    const doc = build({}, {}, template, {
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      contentType: "image/png",
    });
    const { warnings } = await renderDocxDocument(doc, "paper", A4);
    expect(warnings).toEqual([
      { code: "logoOmitted", where: { part: "letterhead" }, source: "image/png" },
    ]);
  });
});

describe("renderDocx hostile text", () => {
  const hostile =
    "<script>alert(1)</script> &amp; &lt;b&gt; ]]> \"q\" 'a' \u0000nul\u0008bs\u000bvt\uFFFEend \uD800lone";

  it("escapes markup and drops characters XML 1.0 forbids, in every part", async () => {
    const tpl = { ...template, schoolName: hostile, headerLines: [hostile] };
    const options = labelled([hostile, "B", "C", "D"]);
    const doc = build(
      { title: hostile, instructionsMd: hostile },
      { i1: version(hostile, "A", { options, steps: [hostile] }) },
      tpl,
    );
    for (const kind of ["paper", "key", "solutions"] as const) {
      const bytes = await renderDocx(doc, kind, A4);
      const zip = await unzip(bytes);
      for (const name of Object.keys(zip.files)) {
        if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
        const xml = await zip.file(name)!.async("string");
        expect(() => {
          assertWellFormed(xml);
        }, `${kind} ${name}`).not.toThrow();
        expect(xml, name).not.toContain("<script>");
        expect(xml, name).not.toMatch(
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFE\uFFFF]/,
        );
      }
      const text = wordText(await zip.file("word/document.xml")!.async("string")).join(
        "",
      );
      expect(text).toContain("<script>alert(1)</script> &amp; &lt;b&gt; ]]>");
      expect(text).toContain("nulbsvtend");
    }
  });

  it("keeps hostile LaTeX safe in both the equation and the fallback", async () => {
    const stem = "A $\\text{<script>\\&}$ B $\\bad<script>\u0000$ C";
    const { bytes, warnings } = await renderDocxDocument(
      build({}, { i1: version(stem) }),
      "paper",
      A4,
    );
    const xml = await part(bytes, "word/document.xml");
    assertWellFormed(xml);
    expect(xml).not.toContain("<script>");
    expect(warnings).toHaveLength(1);
    expect(count(xml, /<m:oMath/g)).toBe(1);
  });
});

describe("renderDocx scale", () => {
  it("renders 200 items with formulas in reasonable time", async () => {
    const versions = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `i${String(i + 1)}`,
        version(`Soal $\\frac{${String(i)}}{2} + \\sqrt{x^2}$ panjang`, "A"),
      ]),
    );
    const base = snapshot({}, versions);
    // 40 copies of each of the five items: 200 items in two sections.
    const sections = base.sections.map((section) => ({
      ...section,
      items: Array.from({ length: 40 }, (_, copy) =>
        section.items.map((item) => ({
          ...item,
          itemId: `${item.itemId}-${String(copy)}`,
        })),
      ).flat(),
    }));
    const doc = buildDocumentModel({ ...base, sections }, template);
    expect(doc.sections.flatMap((s) => s.items)).toHaveLength(200);
    const started = performance.now();
    const bytes = await renderDocx(doc, "paper", A4);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(15_000);
    const xml = await part(bytes, "word/document.xml");
    expect(count(xml, /<m:oMath>/g)).toBe(200);
  }, 30_000);
});

describe("renderDocx OOXML injection", () => {
  /** Element names with their ancestors, and the decoded text of each m:t / w:t. */
  function tree(xml: string) {
    const names: string[] = [];
    const nested: string[] = [];
    const texts: string[] = [];
    const attributes: string[] = [];
    const stack: string[] = [];
    let text: string | null = null;
    const parser = new SaxesParser();
    parser.on("error", (error) => {
      throw error;
    });
    parser.on("opentag", (tag) => {
      names.push(tag.name);
      if (
        stack.includes("m:oMath") &&
        tag.name.startsWith("w:") &&
        tag.name !== "w:rPr"
      ) {
        nested.push(tag.name);
      }
      for (const value of Object.values(tag.attributes)) attributes.push(value);
      stack.push(tag.name);
      if (tag.name === "m:t" || tag.name === "w:t") text = "";
    });
    parser.on("text", (value) => {
      if (text !== null) text += value;
    });
    parser.on("closetag", (tag) => {
      stack.pop();
      if ((tag.name === "m:t" || tag.name === "w:t") && text !== null) {
        texts.push(text);
        text = null;
      }
    });
    parser.write(xml).close();
    return { names, nested, texts, attributes };
  }

  const HOSTILE_STEM = String.raw`Teks x&y <w:p> &lt;w:p&gt; "q" 'a' $\text{\&lt;w:p\&gt;}$ dan $a<b$ dan $x \& y > z$ dan $\text{"q" 'a' <w:r/>}$.`;
  // The same structure with harmless characters: the element tree must be identical.
  const PLAIN_STEM = String.raw`Teks xxy xxxxx xxxxxxxxxxx xxx xxx $\text{xxxxxxxxxxx}$ dan $axb$ dan $x \& y + z$ dan $\text{xxx xxx xxxxxx}$.`;

  it("keeps hostile text and formulas as text: same element tree as a harmless twin", async () => {
    const render = async (stem: string) =>
      part(
        await renderDocx(build({}, { i1: version(stem) }), "paper", A4),
        "word/document.xml",
      );
    const hostile = tree(await render(HOSTILE_STEM));
    const plain = tree(await render(PLAIN_STEM));
    expect(hostile.nested).toEqual([]);
    expect(hostile.names).toEqual(plain.names);
    const all = hostile.texts.join("");
    expect(all).toContain("Teks x&y <w:p> &lt;w:p&gt; \"q\" 'a' ");
    expect(hostile.texts).toContain("&lt;w:p&gt;");
    expect(all).toContain("a<b");
    // KaTeX typesets the quotes and spaces (no-break) in \text; the markup stays text.
    expect(all).toMatch(/"q"\s.a.\s<w:r\/>/u);
  });

  it("re-escapes text and attribute values of imported OMML", async () => {
    const omml =
      '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">' +
      '<m:r><m:rPr><m:sty m:val="&quot;/&gt;&lt;w:p&gt;&amp;x"/></m:rPr>' +
      "<m:t>&lt;/m:t&gt;&lt;w:p&gt;&lt;w:r&gt;&lt;w:t&gt;owned&amp;amp;</m:t></m:r></m:oMath>";
    const file = new Document({
      sections: [{ children: [new Paragraph({ children: [ommlComponent(omml)] })] }],
    });
    const xml = await part(
      new Uint8Array(await Packer.toBuffer(file)),
      "word/document.xml",
    );
    const { names, nested, texts, attributes } = tree(xml);
    expect(nested).toEqual([]);
    expect(names.filter((n) => n === "w:p")).toHaveLength(1);
    expect(texts).toContain("</m:t><w:p><w:r><w:t>owned&amp;");
    expect(attributes).toContain('"/><w:p>&x');
  });

  it("refuses a package whose document.xml is not well-formed", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:document><w:body><w:p></w:body></w:document>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(assertDocxWellFormed(bytes)).rejects.toMatchObject({
      name: "RenderDocxError",
      code: "render",
    });
    const good = await renderDocx(build(), "paper", A4);
    await expect(assertDocxWellFormed(good)).resolves.toBeUndefined();
  });

  it("refuses a package without document.xml", async () => {
    const zip = new JSZip();
    zip.file("other.xml", "<a/>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(assertDocxWellFormed(bytes)).rejects.toBeInstanceOf(RenderDocxError);
  });

  it("renderDocx itself refuses a malformed package with code render", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:document><w:t>a<w:p></w:t></w:document>");
    const broken = await zip.generateAsync({ type: "nodebuffer" });
    const spy = vi.spyOn(Packer, "toBuffer").mockResolvedValue(broken);
    try {
      await expect(renderDocxDocument(build(), "paper", A4)).rejects.toMatchObject({
        name: "RenderDocxError",
        code: "render",
        message: "Word renderer: the document could not be built",
      });
    } finally {
      spy.mockRestore();
    }
  });
});
