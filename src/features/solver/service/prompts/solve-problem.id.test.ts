import { describe, expect, it } from "vitest";
import { buildSolvePrompt } from "./solve-problem.id";

describe("buildSolvePrompt and literal line-break escapes (S-10)", () => {
  it.each([[[]], [["Substitusi"]]])(
    "tells the model not to write a backslash-n in a step (excluded methods: %j)",
    (excludeMethods) => {
      const { prompt } = buildSolvePrompt({
        problemMd: "Tentukan x jika 2x + 3 = 11",
        excludeMethods,
      });
      expect(prompt).toContain("jangan menulis dua karakter \\n");
    },
  );
});
