// Scripted answers for the materials and solver calls of the e2e fake AI (plan 5, Task 9). No
// imports: the Playwright specs read the same constants (tests/e2e/materials.spec.ts and
// solver.spec.ts), so what a spec expects on screen is what the provider answered.

/** What the fake vision model reads on a page image: one part marked uncertain ([[?]], R14). */
export const E2E_OCR_MARKDOWN =
  "Sistem persamaan linear dua variabel\n\n" +
  "Tentukan penyelesaian dari $x + y = 7$ dan [[?]]$x - y = 1$[[?]].";

/** What the fake vision model reads on a solver photo: the sum is marked uncertain (SOL-02). */
export const E2E_PHOTO_MARKDOWN = "Hitung [[?]]$12 + 30$[[?]].";

/** The method labels of the first solution and of "show another method". */
export const E2E_METHOD = "Penjumlahan langsung";
export const E2E_ALTERNATIVE_METHOD = "Penjumlahan bersusun";

/** The passage id the invented_citation scenario cites although no prompt ever offered it. */
export const E2E_INVENTED_PASSAGE = "P99";

/** The first `a + b` with whole numbers in a problem text, or null. */
export function addendsOf(text: string): [number, number] | null {
  const match = /(\d+)\s*\+\s*(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export const ocrAnswer = () => JSON.stringify({ markdown: E2E_OCR_MARKDOWN });

export const extractAnswer = () => JSON.stringify({ markdown: E2E_PHOTO_MARKDOWN });

/**
 * A solution of `a + b` whose claim recomputes the answer from the problem's own numbers (R26),
 * so with an agreeing cross-check it is "verified automatically".
 */
export function solutionAnswer([a, b]: [number, number], alternative: boolean): string {
  const sum = String(a + b);
  return JSON.stringify({
    method: alternative ? E2E_ALTERNATIVE_METHOD : E2E_METHOD,
    steps: alternative
      ? [
          {
            title: "Susun ke bawah",
            body_md: `Tulis $${String(a)}$ di atas $${String(b)}$.`,
          },
          { title: "Jumlahkan", body_md: `Satuan lalu puluhan: hasilnya $${sum}$.` },
        ]
      : [{ title: "Jumlahkan", body_md: `$${String(a)} + ${String(b)} = ${sum}$` }],
    final_answer: { value: sum, unit: null, rounding: null },
    verification_claims: [
      { type: "numeric_eval", expression: `${String(a)}+${String(b)}`, expected: sum },
    ],
  });
}

/** The independent second solve: the same sum, so it agrees. */
export const crossCheckAnswer = ([a, b]: [number, number]) =>
  JSON.stringify({ answer: String(a + b) });

/** One chapter over every page, mapped to the listed topic when one was found. */
export function structureAnswer(pageCount: number, topicKey: string | null): string {
  return JSON.stringify({
    title: "Buku e2e: sistem persamaan linear dua variabel",
    grade: 8,
    chapters: [
      {
        title: "Sistem persamaan linear dua variabel",
        pageStart: 1,
        pageEnd: pageCount,
        topicKey,
      },
    ],
  });
}

/**
 * A generation batch (JSON text) whose questions cite the prompt's passages in turn; with
 * `invent`, question 1 cites a passage that was never offered instead.
 */
export function withCitations(
  batch: string,
  passageIds: readonly string[],
  invent: boolean,
): string {
  const parsed = JSON.parse(batch) as { questions: Record<string, unknown>[] };
  return JSON.stringify({
    questions: parsed.questions.map((question, index) => ({
      ...question,
      citations: [
        invent && index === 0
          ? E2E_INVENTED_PASSAGE
          : passageIds[index % passageIds.length],
      ],
    })),
  });
}
