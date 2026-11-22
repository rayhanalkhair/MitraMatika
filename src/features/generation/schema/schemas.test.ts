import { describe, expect, it } from "vitest";
import { multipleChoiceBatchSchema, multipleChoiceQuestionSchema } from "./schemas";

function validQuestion() {
  return {
    stem_md: "Berapakah hasil dari $3^2 + 4^2$?",
    options: [
      { label: "A", text_md: "24" },
      { label: "B", text_md: "25" },
      { label: "C", text_md: "26" },
      { label: "D", text_md: "27" },
    ],
    correctLabel: "B",
    answer: { display_md: "25", machine: "25" },
    explanation_md: "Gunakan teorema Pythagoras.",
    steps: ["Hitung $3^2 = 9$.", "Hitung $4^2 = 16$.", "Jumlahkan: $9 + 16 = 25$."],
    verification_claims: [
      { type: "numeric_eval", expression: "3^2 + 4^2", expected: "25" },
      {
        type: "choice_matches_answer",
        options: ["24", "25", "26", "27"],
        markedIndex: 1,
        answer: "25",
      },
    ],
    metadata: { difficulty: "sedang", estimatedMinutes: 3, tags: ["pythagoras"] },
  };
}

describe("multipleChoiceQuestionSchema", () => {
  it("accepts a valid question", () => {
    expect(multipleChoiceQuestionSchema.safeParse(validQuestion()).success).toBe(true);
  });

  it("rejects fewer than 4 options", () => {
    const q = validQuestion();
    q.options = q.options.slice(0, 3);
    expect(multipleChoiceQuestionSchema.safeParse(q).success).toBe(false);
  });

  it("rejects duplicate option labels", () => {
    const q = validQuestion();
    q.options[1].label = "A";
    expect(multipleChoiceQuestionSchema.safeParse(q).success).toBe(false);
  });

  it("rejects fewer than 2 steps", () => {
    const q = validQuestion();
    q.steps = ["Satu langkah saja."];
    expect(multipleChoiceQuestionSchema.safeParse(q).success).toBe(false);
  });

  it("rejects an empty verification_claims array", () => {
    const q = validQuestion();
    q.verification_claims = [];
    expect(multipleChoiceQuestionSchema.safeParse(q).success).toBe(false);
  });

  it("rejects an invalid difficulty", () => {
    const q = validQuestion();
    q.metadata.difficulty = "gampang";
    expect(multipleChoiceQuestionSchema.safeParse(q).success).toBe(false);
  });

  it("accepts each of the four claim types", () => {
    const claims = [
      { type: "numeric_eval", expression: "2+2", expected: "4" },
      { type: "expression_equivalent", a: "x+1", b: "1+x", variables: ["x"] },
      { type: "equation_solution", equation: "x-1=0", variable: "x", solutions: ["1"] },
      {
        type: "choice_matches_answer",
        options: ["1", "2"],
        markedIndex: 0,
        answer: "1",
      },
    ];
    for (const claim of claims) {
      const q = validQuestion();
      q.verification_claims = [claim as never];
      expect(multipleChoiceQuestionSchema.safeParse(q).success).toBe(true);
    }
  });

  it("rejects an unknown claim type", () => {
    const q = validQuestion();
    q.verification_claims = [{ type: "unit_conversion" } as never];
    expect(multipleChoiceQuestionSchema.safeParse(q).success).toBe(false);
  });
});

describe("multipleChoiceBatchSchema", () => {
  it("accepts a batch of valid questions", () => {
    const batch = { questions: [validQuestion(), validQuestion()] };
    expect(multipleChoiceBatchSchema.safeParse(batch).success).toBe(true);
  });

  it("rejects an empty batch", () => {
    expect(multipleChoiceBatchSchema.safeParse({ questions: [] }).success).toBe(false);
  });

  it("rejects a batch larger than 10", () => {
    const batch = { questions: Array.from({ length: 11 }, validQuestion) };
    expect(multipleChoiceBatchSchema.safeParse(batch).success).toBe(false);
  });
});
