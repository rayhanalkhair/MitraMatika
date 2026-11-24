import { describe, expect, it } from "vitest";
import { buildSolveIndependentPrompt } from "./solve-independent.id";

describe("buildSolveIndependentPrompt", () => {
  it("warns the model to double every backslash in LaTeX since the field is a JSON string value", () => {
    const { prompt } = buildSolveIndependentPrompt({
      questionStemMd: "Soal contoh",
      optionTexts_md: ["1", "2", "3", "4"],
      dataClass: "C0",
    });

    expect(prompt).toContain("nilai string JSON");
    // The correct (doubled-backslash) example the model should follow: two
    // literal backslash characters immediately before "frac".
    expect(prompt).toContain("\\\\frac{1}{2}");
    // The wrong (single-backslash) example shown for contrast: exactly one
    // literal backslash character before "frac", not doubled and not tripled.
    const singleBackslashExample = '"\\frac{1}{2}"';
    expect(prompt).toContain(singleBackslashExample);
  });
});

describe("literal line-break escapes (S-10)", () => {
  it("tells the model not to write a backslash-n outside formulas", () => {
    const { prompt } = buildSolveIndependentPrompt({
      questionStemMd: "Soal contoh",
      optionTexts_md: ["1", "2", "3", "4"],
      dataClass: "C0",
    });
    expect(prompt).toContain("Jangan menulis dua karakter \\n");
  });
});
