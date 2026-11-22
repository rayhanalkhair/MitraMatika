import { describe, expect, it } from "vitest";
import {
  goldenGenerationSetSchema,
  goldenOcrManifestSchema,
  goldenOcrSetSchema,
  goldenSolverSetSchema,
  validateGoldenGenerationSet,
  validateGoldenOcrManifest,
  validateGoldenSolverSet,
} from "./golden-set-schema";

function validGenerationSpec() {
  return {
    id: "bilangan-berpangkat-mudah-1",
    grade: 8,
    topicStableKey: "bilangan-berpangkat-dan-bentuk-akar",
    topicTitle: "Bilangan Berpangkat, Bentuk Akar, dan Notasi Ilmiah",
    difficulty: "mudah",
    count: 1,
    sourceRef:
      "data/curriculum/grade-8-v1.json, topik bilangan-berpangkat-dan-bentuk-akar",
  };
}

function validSolverProblem() {
  return {
    id: "pythagoras-hipotenusa-1",
    grade: 8,
    topicStableKey: "teorema-pythagoras",
    difficulty: "mudah",
    stem_md:
      "Sebuah segitiga siku-siku memiliki dua sisi siku-siku sepanjang 9 cm dan 12 cm. Berapa panjang sisi miringnya?",
    options: [
      { label: "A", text_md: "15 cm" },
      { label: "B", text_md: "18 cm" },
      { label: "C", text_md: "21 cm" },
      { label: "D", text_md: "225 cm" },
    ],
    correctLabel: "A",
    answer: { display_md: "15 cm", machine: "15" },
    sourceRef:
      "Ditulis mengikuti gaya soal Bab 2 Teorema Pythagoras, Matematika untuk SMP/MTs Kelas VIII (Kemdikbud, 2022), bukan kutipan langsung.",
  };
}

function validOcrPage() {
  return {
    id: "ocr-text-pdf-1",
    kind: "text_pdf",
    path: ".spikes-output/fixtures/Matematika-BS-KLS-VIII-Baru.pdf",
    pageNumber: 30,
    expectedText_md: "Bab 1 Bilangan Berpangkat",
    sourceRef:
      "Matematika untuk SMP/MTs Kelas VIII (Kemdikbud, 2022), ISBN 978-602-427-919-6, hlm. 1",
  };
}

describe("goldenGenerationSetSchema", () => {
  it("accepts a valid set", () => {
    const set = { version: "v1", items: [validGenerationSpec()] };
    expect(goldenGenerationSetSchema.safeParse(set).success).toBe(true);
  });

  it("rejects an empty items array", () => {
    const set = { version: "v1", items: [] };
    expect(goldenGenerationSetSchema.safeParse(set).success).toBe(false);
  });

  it("rejects an invalid difficulty", () => {
    const spec = { ...validGenerationSpec(), difficulty: "gampang" as never };
    const set = { version: "v1", items: [spec] };
    expect(goldenGenerationSetSchema.safeParse(set).success).toBe(false);
  });

  it("rejects a grade other than 8", () => {
    const spec = { ...validGenerationSpec(), grade: 9 as never };
    const set = { version: "v1", items: [spec] };
    expect(goldenGenerationSetSchema.safeParse(set).success).toBe(false);
  });
});

describe("validateGoldenGenerationSet", () => {
  it("returns ok for a valid set with unique ids", () => {
    const set = {
      version: "v1",
      items: [validGenerationSpec(), { ...validGenerationSpec(), id: "other-id" }],
    };
    const result = validateGoldenGenerationSet(set);
    expect(result.ok).toBe(true);
  });

  it("flags duplicate ids", () => {
    const set = { version: "v1", items: [validGenerationSpec(), validGenerationSpec()] };
    const result = validateGoldenGenerationSet(set);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("ganda"))).toBe(true);
    }
  });
});

describe("goldenSolverSetSchema", () => {
  it("accepts a valid set", () => {
    const set = { version: "v1", items: [validSolverProblem()] };
    expect(goldenSolverSetSchema.safeParse(set).success).toBe(true);
  });

  it("rejects a problem missing an expected answer", () => {
    const problem: Record<string, unknown> = { ...validSolverProblem() };
    delete problem.answer;
    const set = { version: "v1", items: [problem] };
    expect(goldenSolverSetSchema.safeParse(set).success).toBe(false);
  });
});

describe("validateGoldenSolverSet", () => {
  it("flags duplicate ids", () => {
    const set = { version: "v1", items: [validSolverProblem(), validSolverProblem()] };
    const result = validateGoldenSolverSet(set);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("ganda"))).toBe(true);
    }
  });
});

describe("goldenOcrSetSchema", () => {
  it("accepts a valid set", () => {
    const set = { version: "v1", items: [validOcrPage()] };
    expect(goldenOcrSetSchema.safeParse(set).success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const page = { ...validOcrPage(), kind: "fax" as never };
    const set = { version: "v1", items: [page] };
    expect(goldenOcrSetSchema.safeParse(set).success).toBe(false);
  });
});

function validOcrManifestEntry() {
  return {
    id: "ocr-text-pdf-1",
    kind: "text_pdf",
    pageNumber: 30,
    sha256: "a".repeat(64),
    sourceRef:
      "Matematika untuk SMP/MTs Kelas VIII (Kemdikbud, 2022), ISBN 978-602-427-919-6, hlm. 10",
  };
}

describe("goldenOcrManifestSchema", () => {
  it("accepts a valid manifest without any real content fields", () => {
    const set = { version: "v1", items: [validOcrManifestEntry()] };
    expect(goldenOcrManifestSchema.safeParse(set).success).toBe(true);
  });

  it("rejects a malformed sha256", () => {
    const entry = { ...validOcrManifestEntry(), sha256: "not-a-hash" };
    const set = { version: "v1", items: [entry] };
    expect(goldenOcrManifestSchema.safeParse(set).success).toBe(false);
  });
});

describe("validateGoldenOcrManifest", () => {
  it("flags duplicate ids", () => {
    const set = {
      version: "v1",
      items: [validOcrManifestEntry(), validOcrManifestEntry()],
    };
    const result = validateGoldenOcrManifest(set);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("ganda"))).toBe(true);
    }
  });
});
