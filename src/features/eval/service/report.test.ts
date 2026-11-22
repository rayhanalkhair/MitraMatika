import { describe, expect, it } from "vitest";
import type { EvalReport } from "./run-eval";
import { formatJson, formatMarkdown } from "./report";

function sampleReport(): EvalReport {
  return {
    generatedAt: "2026-09-26T00:00:00.000Z",
    provider: "fake",
    thresholds: { correctKeys: 0.9, plantedErrorsCaught: 0.9, schemaValid: 0.98 },
    generation: [
      {
        specId: "spec-1",
        ok: true,
        schemaValid: true,
        question: {
          stem_md: "Berapakah $2+2$?",
          options: [
            { label: "A", text_md: "3" },
            { label: "B", text_md: "4" },
            { label: "C", text_md: "5" },
            { label: "D", text_md: "6" },
          ],
          correctLabel: "B",
          answer: { display_md: "4", machine: "4" },
          explanation_md: "Jumlahkan.",
          steps: ["Hitung."],
          verification_claims: [
            { type: "numeric_eval", expression: "2+2", expected: "4" },
          ],
          metadata: { difficulty: "mudah" },
        },
        keyAccuracyVerified: true,
        plantedErrorCaught: true,
        crossCheckAgreed: true,
        tokensPrompt: 100,
        tokensCompletion: 50,
        latencyMs: 500,
      },
      {
        specId: "spec-2",
        ok: false,
        schemaValid: false,
        error: "Keluaran tidak valid setelah perbaikan.",
      },
    ],
    solver: [
      {
        problemId: "prob-1",
        ok: true,
        correct: true,
        tokensPrompt: 40,
        tokensCompletion: 20,
        latencyMs: 300,
      },
    ],
    summary: {
      schemaValidRate: 0.5,
      keyAccuracyRate: 0.5,
      plantedErrorCatchRate: 1,
      crossCheckAgreementRate: 1,
      solverAccuracyRate: 1,
      totalTokens: 210,
      avgLatencyMs: 400,
    },
  };
}

describe("formatMarkdown", () => {
  it("includes the summary table with pass/fail against D-019 thresholds", () => {
    const md = formatMarkdown(sampleReport());
    expect(md).toContain("Kunci jawaban benar");
    expect(md).toContain("90.0%");
    expect(md).toContain("50.0%");
  });

  it("includes a blank rating block for each successfully generated question", () => {
    const md = formatMarkdown(sampleReport());
    expect(md).toContain("spec-1");
    expect(md).toContain("Berapakah $2+2$?");
    expect(md).toContain("Skor (1-5): ____");
  });

  it("shows the error for a failed generation spec instead of a rating block", () => {
    const md = formatMarkdown(sampleReport());
    expect(md).toContain("spec-2");
    expect(md).toContain("Keluaran tidak valid setelah perbaikan.");
  });

  it("includes the solver results table", () => {
    const md = formatMarkdown(sampleReport());
    expect(md).toContain("prob-1");
    expect(md).toContain("ya");
  });

  it("separates the options list from the answer/explanation/rating fields with blank lines, so a CommonMark renderer doesn't absorb them into the last option via lazy continuation", () => {
    const md = formatMarkdown(sampleReport());
    // Without a blank line, "Jawaban ditandai: ..." is a lazy-continuation
    // line of the preceding list item ("- D. 6"), and renders glued onto it
    // instead of as its own line — this is the exact bug a real report
    // exhibited when viewed in a Markdown renderer.
    expect(md).toContain("- D. 6\n\nJawaban ditandai: B");
    expect(md).toContain("Jawaban ditandai: B\n\nPenjelasan: Jumlahkan.");
    expect(md).toContain("Skor (1-5): ____\n\nCatatan: ____");
  });

  it("escapes pipes and newlines in a solver error so the table row stays intact", () => {
    const base = sampleReport();
    const baseLineCount = formatMarkdown(base).split("\n").length;
    const report: EvalReport = {
      ...base,
      solver: [
        {
          problemId: "prob-1",
          ok: false,
          correct: false,
          error: "invalid | value\nsecond line",
        },
      ],
    };

    const md = formatMarkdown(report);
    const lines = md.split("\n");
    const row = lines.find((line) => line.startsWith("| prob-1 |"));

    expect(lines.length).toBe(baseLineCount);
    expect(row).toBe("| prob-1 | tidak | invalid \\| value second line |");
  });
});

describe("formatJson", () => {
  it("round-trips the report exactly", () => {
    const report = sampleReport();
    const json = formatJson(report);
    expect(JSON.parse(json)).toEqual(report);
  });
});
