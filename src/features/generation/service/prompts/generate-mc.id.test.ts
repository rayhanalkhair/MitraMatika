import { describe, expect, it } from "vitest";
import {
  buildGenerateMcPrompt,
  clampCorrectionNote,
  GENERATE_MC_PROMPT_VERSION,
} from "./generate-mc.id";

describe("buildGenerateMcPrompt", () => {
  it("warns the model to double every backslash in LaTeX since these fields are JSON string values", () => {
    const { prompt } = buildGenerateMcPrompt({
      grade: 8,
      topicTitle: "Topik contoh",
      topicScopeNotes: "Cakupan contoh",
      difficulty: "mudah",
      count: 1,
      dataClass: "C0",
    });

    expect(prompt).toContain("nilai string JSON");
    // The correct (doubled-backslash) example the model should follow: two
    // literal backslash characters immediately before "frac".
    expect(prompt).toContain("\\\\frac{1}{2}");
    // The wrong (single-backslash) example shown for contrast: exactly one
    // literal backslash character before "frac".
    const singleBackslashExample = '"\\frac{1}{2}"';
    expect(prompt).toContain(singleBackslashExample);
  });

  it("tells the model that verification_claims fields must use plain math syntax, not LaTeX", () => {
    // A real benchmark run found the model writing "\\sqrt{81}" (LaTeX)
    // inside a numeric_eval claim's "expression" field — mathjs (the
    // verifier's expression engine) can't parse LaTeX syntax at all, so the
    // claim was marked unsupported even though the underlying math was
    // correct.
    const { prompt } = buildGenerateMcPrompt({
      grade: 8,
      topicTitle: "Topik contoh",
      topicScopeNotes: "Cakupan contoh",
      difficulty: "mudah",
      count: 1,
      dataClass: "C0",
    });
    expect(prompt).toContain("sqrt(81)");
    expect(prompt).toContain("verification_claims");
  });

  it("tells the model that verification_claims numeric values must be full precision, not rounded", () => {
    // A real benchmark run found the model writing "expected": "7.33" for a
    // value that is actually 7.330382858... — the verifier's tight
    // tolerance (relative 1e-9) correctly rejected the rounded value as a
    // mismatch, even though the answer was conceptually right.
    const { prompt } = buildGenerateMcPrompt({
      grade: 8,
      topicTitle: "Topik contoh",
      topicScopeNotes: "Cakupan contoh",
      difficulty: "mudah",
      count: 1,
      dataClass: "C0",
    });
    expect(prompt).toContain("presisi penuh");
  });
});

describe("objectives in the prompt", () => {
  const base = {
    grade: 8 as const,
    topicTitle: "SPLDV",
    topicScopeNotes: "Sistem persamaan linear dua variabel.",
    difficulty: "sedang" as const,
    count: 2,
    dataClass: "C0" as const,
  };

  it("lists the learning objectives when they are given", () => {
    const { prompt } = buildGenerateMcPrompt({
      ...base,
      objectives: [
        { code: "TP-1", text: "Menyelesaikan SPLDV." },
        { code: "TP-2", text: "Menyusun model SPLDV." },
      ],
    });
    expect(prompt).toContain("Tujuan pembelajaran:");
    expect(prompt).toContain("- TP-1: Menyelesaikan SPLDV.");
    expect(prompt).toContain("- TP-2: Menyusun model SPLDV.");
  });

  it("leaves the block out when there are none", () => {
    expect(buildGenerateMcPrompt(base).prompt).not.toContain("Tujuan pembelajaran");
    expect(buildGenerateMcPrompt({ ...base, objectives: [] }).prompt).not.toContain(
      "Tujuan pembelajaran",
    );
  });

  it("asks for unit exponents inside math delimiters", () => {
    expect(buildGenerateMcPrompt(base).prompt).toContain("$24\\\\text{ cm}^2$");
  });

  it("exposes a prompt version", () => {
    expect(GENERATE_MC_PROMPT_VERSION).toBe("generate-mc.id@2");
  });
});

describe("correction note", () => {
  const base = {
    grade: 8 as const,
    topicTitle: "SPLDV",
    topicScopeNotes: "Sistem persamaan linear dua variabel.",
    difficulty: "sedang" as const,
    count: 1,
    dataClass: "C0" as const,
  };

  it("adds a block when a note is given", () => {
    const { prompt } = buildGenerateMcPrompt({
      ...base,
      correctionNote: "Pilihan yang ditandai (13) tidak sama dengan jawaban (14).",
    });
    expect(prompt).toContain("Catatan perbaikan");
    expect(prompt).toContain(
      "Pilihan yang ditandai (13) tidak sama dengan jawaban (14).",
    );
  });

  it("leaves the block out without a note", () => {
    expect(buildGenerateMcPrompt(base).prompt).not.toContain("Catatan perbaikan");
  });

  it("clamps the note to 300 characters on one line", () => {
    const clamped = clampCorrectionNote(`baris satu\nbaris dua   ${"x".repeat(400)}`);
    expect(clamped).not.toContain("\n");
    expect(clamped.length).toBe(300);
    expect(clamped.startsWith("baris satu baris dua x")).toBe(true);
  });
});

describe("literal line-break escapes (S-10)", () => {
  it("tells the model not to write a backslash-n outside formulas", () => {
    const { prompt } = buildGenerateMcPrompt({
      grade: 8,
      topicTitle: "Topik contoh",
      topicScopeNotes: "Cakupan contoh",
      difficulty: "mudah",
      count: 1,
      dataClass: "C0",
    });
    expect(prompt).toContain("Jangan menulis dua karakter \\n");
  });
});
