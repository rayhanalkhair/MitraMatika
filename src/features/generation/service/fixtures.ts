// Pure fixture builders for AI answers. No test-only imports: the e2e fake provider uses
// them at runtime, and test-support.ts re-exports them for the unit tests.

export function questionJson(n: number, difficulty = "sedang") {
  const answer = 2 * n;
  return {
    stem_md: `Hitung $${String(n)} + ${String(n)}$.`,
    options: [
      { label: "A", text_md: String(answer - 1) },
      { label: "B", text_md: String(answer) },
      { label: "C", text_md: String(answer + 1) },
      { label: "D", text_md: String(answer + 2) },
    ],
    correctLabel: "B",
    answer: { display_md: String(answer), machine: String(answer) },
    explanation_md: "Jumlahkan kedua bilangan.",
    steps: ["Tulis soalnya.", "Jumlahkan kedua bilangan."],
    verification_claims: [
      {
        type: "numeric_eval",
        expression: `${String(n)}+${String(n)}`,
        expected: String(answer),
      },
    ],
    metadata: { difficulty },
  };
}

export function batchJson(count: number, difficulty = "sedang"): string {
  return JSON.stringify({
    questions: Array.from({ length: count }, (_, i) => questionJson(i + 1, difficulty)),
  });
}

// A scripted answer for the solve_independent task: the solver's own pick and working.
export function solverJson(label: "A" | "B" | "C" | "D", machine: string) {
  return {
    correctLabel: label,
    answer: { display_md: machine, machine },
    steps: ["Tulis soalnya.", "Hitung hasilnya."],
  };
}
