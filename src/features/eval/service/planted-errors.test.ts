import { describe, expect, it } from "vitest";
import { evaluateClaim, verifyClaims } from "@/features/verification";
import type { MultipleChoiceQuestion } from "@/features/generation";
import { plantError } from "./planted-errors";

function baseQuestion(
  claims: MultipleChoiceQuestion["verification_claims"],
): MultipleChoiceQuestion {
  return {
    stem_md: "Soal contoh",
    options: [
      { label: "A", text_md: "1" },
      { label: "B", text_md: "2" },
      { label: "C", text_md: "3" },
      { label: "D", text_md: "4" },
    ],
    correctLabel: "B",
    answer: { display_md: "2", machine: "2" },
    explanation_md: "Penjelasan.",
    steps: ["Langkah 1.", "Langkah 2."],
    verification_claims: claims,
    metadata: { difficulty: "mudah" },
  };
}

describe("plantError", () => {
  it("corrupts a numeric_eval claim so it fails verification", () => {
    const question = baseQuestion([
      { type: "numeric_eval", expression: "2+2", expected: "4" },
    ]);
    expect(evaluateClaim(question.verification_claims[0]).status).toBe("pass");

    const mutated = plantError(question);

    expect(evaluateClaim(mutated.verification_claims[0]).status).toBe("fail");
  });

  it("corrupts an expression_equivalent claim so it fails verification", () => {
    const question = baseQuestion([
      { type: "expression_equivalent", a: "x+1", b: "1+x", variables: ["x"] },
    ]);
    expect(evaluateClaim(question.verification_claims[0]).status).toBe("pass");

    const mutated = plantError(question);

    expect(evaluateClaim(mutated.verification_claims[0]).status).toBe("fail");
  });

  it("corrupts an equation_solution claim so it fails verification", () => {
    const question = baseQuestion([
      { type: "equation_solution", equation: "x-1=0", variable: "x", solutions: ["1"] },
    ]);
    expect(evaluateClaim(question.verification_claims[0]).status).toBe("pass");

    const mutated = plantError(question);

    expect(evaluateClaim(mutated.verification_claims[0]).status).toBe("fail");
  });

  it("corrupts a choice_matches_answer claim so it fails verification", () => {
    const question = baseQuestion([
      {
        type: "choice_matches_answer",
        options: ["1", "2", "3", "4"],
        markedIndex: 1,
        answer: "2",
      },
    ]);
    expect(evaluateClaim(question.verification_claims[0]).status).toBe("pass");

    const mutated = plantError(question);

    expect(evaluateClaim(mutated.verification_claims[0]).status).toBe("fail");
  });

  it("returns a new object and leaves the original question's claim untouched", () => {
    const question = baseQuestion([
      { type: "numeric_eval", expression: "2+2", expected: "4" },
    ]);

    const mutated = plantError(question);

    expect(question.verification_claims[0]).toEqual({
      type: "numeric_eval",
      expression: "2+2",
      expected: "4",
    });
    expect(mutated).not.toBe(question);
  });

  it("throws when the question has no verification claims", () => {
    const question = baseQuestion([]);
    expect(() => plantError(question)).toThrow();
  });

  it("corrupts equation_solution with multiple solutions (each solution must be corrupted, not removed)", () => {
    const question = baseQuestion([
      {
        type: "equation_solution",
        equation: "x^2-1=0",
        variable: "x",
        solutions: ["1", "-1"],
      },
    ]);
    expect(evaluateClaim(question.verification_claims[0]).status).toBe("pass");

    const mutated = plantError(question);

    expect(evaluateClaim(mutated.verification_claims[0]).status).toBe("fail");
  });

  it("corrupts the claim that actually passed, not an unsupported first claim", () => {
    const question = baseQuestion([
      { type: "numeric_eval", expression: "\\frac{1}{2}", expected: "0.5" },
      { type: "numeric_eval", expression: "2+2", expected: "4" },
    ]);
    expect(evaluateClaim(question.verification_claims[0]).status).toBe("unsupported");
    expect(evaluateClaim(question.verification_claims[1]).status).toBe("pass");
    expect(verifyClaims(question.verification_claims).status).toBe("terverifikasi");

    const mutated = plantError(question);

    expect(verifyClaims(mutated.verification_claims).status).toBe("ketidaksesuaian");
    expect(mutated.verification_claims[0]).toEqual(question.verification_claims[0]);
  });

  it("self-verifies equation_solution corruption when +1 lands on another valid root", () => {
    const question = baseQuestion([
      {
        type: "equation_solution",
        equation: "x^2-5x+6=0",
        variable: "x",
        solutions: ["2", "3"],
      },
    ]);
    expect(evaluateClaim(question.verification_claims[0]).status).toBe("pass");

    const mutated = plantError(question);

    expect(evaluateClaim(mutated.verification_claims[0]).status).toBe("fail");
  });

  it("corrupts numeric_eval with percent-formatted expected value (format must be preserved)", () => {
    const question = baseQuestion([
      { type: "numeric_eval", expression: "1/2", expected: "50%" },
    ]);
    expect(evaluateClaim(question.verification_claims[0]).status).toBe("pass");

    const mutated = plantError(question);

    expect(evaluateClaim(mutated.verification_claims[0]).status).toBe("fail");
  });
});
