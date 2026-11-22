import { describe, expect, it } from "vitest";
import { numberedOrder } from "@/features/assessments";
import { buildDocumentModel, keyRows } from "./document-model";
import { snapshot, template, version } from "../test-support";

type Doc = ReturnType<typeof buildDocumentModel>;
const numbers = (doc: Doc) =>
  doc.sections.flatMap((section) => section.items.map((item) => item.number));
const ids = (doc: Doc) =>
  doc.sections.flatMap((section) => section.items.map((item) => item.itemId));

describe("buildDocumentModel numbering", () => {
  it("numbers 1..n in outline order without a seed", () => {
    const doc = buildDocumentModel(snapshot(), template);
    expect(ids(doc)).toEqual(["i1", "i2", "i3", "i4", "i5"]);
    expect(numbers(doc)).toEqual([1, 2, 3, 4, 5]);
  });

  it("follows numberedOrder(sections, seed) when shuffle is on", () => {
    const snap = snapshot({ shuffleSeed: 424242 });
    const doc = buildDocumentModel(snap, template);
    const expected = numberedOrder(
      snap.sections.map((s) => ({ id: s.id, itemIds: s.items.map((i) => i.itemId) })),
      424242,
    );
    expect(ids(doc)).toEqual(expected.flatMap((s) => s.items.map((i) => i.itemId)));
    expect(numbers(doc)).toEqual([1, 2, 3, 4, 5]);
    // Sections stay in place and items stay inside their section.
    expect(doc.sections.map((s) => s.items.length)).toEqual([3, 2]);
    expect(ids(doc).slice(0, 3).sort()).toEqual(["i1", "i2", "i3"]);
  });

  it("carries the content of the item at each number", () => {
    const doc = buildDocumentModel(snapshot({ shuffleSeed: 7 }), template);
    for (const item of doc.sections.flatMap((s) => s.items)) {
      expect(item.stemMd).toBe(`Soal ${item.itemId}`);
    }
  });
});

describe("keyRows", () => {
  it("matches the paper numbering exactly with shuffle on", () => {
    for (const seed of [1, 99, 424242, 31337]) {
      const doc = buildDocumentModel(snapshot({ shuffleSeed: seed }), template);
      const paper = doc.sections.flatMap((s) => s.items);
      const rows = keyRows(doc);
      expect(rows.map((r) => r.number)).toEqual(paper.map((i) => i.number));
      expect(rows.map((r) => r.number)).toEqual([1, 2, 3, 4, 5]);
      const answerOf: Record<string, string> = {
        i1: "A",
        i2: "B",
        i3: "C",
        i4: "D",
        i5: "A",
      };
      expect(rows.map((r) => r.answer)).toEqual(paper.map((i) => answerOf[i.itemId]));
    }
  });
});

describe("buildDocumentModel content", () => {
  it("scores by the scoring mode (equal: 100 across 5 items)", () => {
    const doc = buildDocumentModel(snapshot(), template);
    expect(doc.sections.flatMap((s) => s.items).map((i) => i.points)).toEqual([
      20, 20, 20, 20, 20,
    ]);
  });

  it("falls back to the stored points when the mode cannot compute", () => {
    const snap = snapshot({ scoringMode: "normalised" });
    const doc = buildDocumentModel(snap, template);
    expect(doc.sections.flatMap((s) => s.items).map((i) => i.points)).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  it("keeps the header lines above the school name, in the preview order", () => {
    const doc = buildDocumentModel(snapshot(), template);
    expect(doc.header.lines).toEqual([
      "PEMERINTAH KOTA CONTOH",
      "DINAS PENDIDIKAN",
      "Jl. Merdeka No. 1",
    ]);
    expect(doc.header.schoolName).toBe("SMP Negeri 1 Contoh");
    expect(doc.header.lines.length).toBeLessThanOrEqual(4);
  });

  it("writes meta in Indonesian", () => {
    const doc = buildDocumentModel(snapshot(), template);
    expect(doc.meta.kindLabel).toBe("Ulangan Harian");
    expect(doc.meta.examDate).toBe("Selasa, 17 November 2026");
    expect(doc.meta.durationMinutes).toBe(90);
    expect(doc.meta.subject).toBe("Matematika");
    expect(doc.meta.instructionsMd).toBe("Berdoalah dahulu.");
  });

  it("uses the template instructions when the assessment has none", () => {
    const doc = buildDocumentModel(snapshot({ instructionsMd: null }), template);
    expect(doc.meta.instructionsMd).toBe("Kerjakan dengan jujur.");
  });

  it("maps the student field toggles to Indonesian labels in order", () => {
    const doc = buildDocumentModel(snapshot(), {
      ...template,
      studentFields: ["name", "number", "date"],
    });
    expect(doc.studentFields.map((f) => f.label)).toEqual([
      "Nama",
      "No. absen",
      "Tanggal",
    ]);
  });

  it("works without a template (defaults)", () => {
    const doc = buildDocumentModel(snapshot(), null);
    expect(doc.header.schoolName).toBe("");
    expect(doc.page).toEqual({ paper: "A4", font: "times" });
    expect(doc.meta.subject).toBe("Matematika");
  });

  it("takes paper and font from the template", () => {
    const doc = buildDocumentModel(snapshot(), {
      ...template,
      paperSize: "F4",
      font: "arial",
    });
    expect(doc.page).toEqual({ paper: "F4", font: "arial" });
  });

  it("chooses the option columns by rendered length", () => {
    const doc = buildDocumentModel(
      snapshot(
        {},
        {
          i1: version("s", "A", {
            options: (["A", "B", "C", "D"] as const).map((label, i) => ({
              label,
              textMd: String(i + 10),
            })),
          }),
        },
      ),
      template,
    );
    expect(doc.sections[0].items[0].columns).toBe(4);
    expect(doc.sections[0].items[0].options).toHaveLength(4);
  });

  it("refuses a snapshot whose version content is missing", () => {
    const snap = snapshot();
    snap.versions = new Map();
    expect(() => buildDocumentModel(snap, template)).toThrow();
  });
});

describe("buildDocumentModel logo (R13: bytes as an image data URI only)", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("encodes a PNG as a base64 data URI", () => {
    const doc = buildDocumentModel(snapshot(), template, {
      logo: { bytes: png, contentType: "image/png" },
    });
    expect(doc.header.logoDataUri).toBe(
      `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
    );
  });

  it("re-sanitises an SVG, keeps it base64 and never exposes markup", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="5" height="5"/></svg>';
    const doc = buildDocumentModel(snapshot(), template, {
      logo: { bytes: new TextEncoder().encode(svg), contentType: "image/svg+xml" },
    });
    const uri = doc.header.logoDataUri ?? "";
    expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const decoded = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
    expect(decoded).not.toMatch(/script|alert/);
    expect(decoded).toContain("<rect");
  });

  it("drops an SVG that does not parse and an unknown content type", () => {
    const bad = buildDocumentModel(snapshot(), template, {
      logo: { bytes: new TextEncoder().encode("<svg><"), contentType: "image/svg+xml" },
    });
    expect(bad.header.logoDataUri).toBeNull();
    const html = buildDocumentModel(snapshot(), template, {
      logo: { bytes: png, contentType: "text/html" },
    });
    expect(html.header.logoDataUri).toBeNull();
  });
});
