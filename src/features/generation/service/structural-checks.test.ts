import { describe, expect, it } from "vitest";
import { multipleChoiceQuestionSchema } from "../schema/schemas";
import { checkMultipleChoice, LENGTH_LIMITS } from "./structural-checks";
import { questionJson } from "./test-support";

const LABELS = ["A", "B", "C", "D"] as const;

// questionJson(3): options 5, 6, 7, 8; key B; machine answer "6".
const make = (patch: Record<string, unknown> = {}) =>
  multipleChoiceQuestionSchema.parse({ ...questionJson(3), ...patch });

const withOptions = (
  texts: [string, string, string, string],
  machine: string,
  correctLabel: (typeof LABELS)[number] = "B",
) =>
  make({
    options: texts.map((text_md, i) => ({ label: LABELS[i], text_md })),
    correctLabel,
    answer: { display_md: machine, machine },
  });

const codes = (question: ReturnType<typeof make>) =>
  checkMultipleChoice(question).map((finding) => finding.code);

describe("checkMultipleChoice", () => {
  it("passes a well-formed question", () => {
    expect(checkMultipleChoice(make())).toEqual([]);
  });

  describe("options_not_distinct", () => {
    it.each([
      ["identical text", ["Persegi", "Persegi", "Lingkaran", "Segitiga"]],
      ["decimal comma vs fraction", ["0,5", "1/2", "3", "4"]],
      ["decimal point vs comma", ["0,5", "0.5", "3", "4"]],
      ["percent vs decimal", ["50%", "0,5", "3", "4"]],
      ["delimiters and spacing", ["$x+1$", "x + 1", "x+2", "x+3"]],
      ["case only", ["Segitiga", "segitiga", "Persegi", "Lingkaran"]],
      ["text wrapper", ["\\text{cm}", "cm", "mm", "m"]],
    ] as const)("flags %s", (_name, texts) => {
      const question = withOptions(
        [...texts] as [string, string, string, string],
        texts[0],
      );
      expect(codes(question)).toContain("options_not_distinct");
    });

    it("names the colliding labels in the message", () => {
      const question = withOptions(["4", "5", "5", "6"], "5");
      const [finding] = checkMultipleChoice(question);
      expect(finding.code).toBe("options_not_distinct");
      expect(finding.message).toContain("B dan C");
    });

    it("does not treat a mixed number as the decimal 5,5", () => {
      expect(codes(withOptions(["1 1/2", "5,5", "3", "4"], "5,5"))).toEqual([]);
    });

    it("passes four distinct values, numeric and text", () => {
      expect(codes(withOptions(["x=2", "x=3", "x=4", "x=5"], "x=3"))).toEqual([]);
      expect(codes(withOptions(["0,25", "0,5", "0,75", "1"], "1/2"))).toEqual([]);
    });
  });

  describe("key_not_final_answer", () => {
    it("flags a marked option that differs from the final answer", () => {
      const question = withOptions(["12", "13", "14", "15"], "14");
      expect(codes(question)).toEqual(["key_not_final_answer"]);
    });

    it("accepts equivalent notation for the key", () => {
      expect(codes(withOptions(["0,25", "0,5", "0,75", "1"], "1/2"))).toEqual([]);
      expect(codes(withOptions(["10%", "50%", "75%", "100%"], "0,5"))).toEqual([]);
    });

    it("ignores math delimiters when comparing", () => {
      expect(codes(withOptions(["$12$", "$13$", "$14$", "$15$"], "13"))).toEqual([]);
      expect(codes(withOptions(["$12$", "$13$", "$14$", "$15$"], "$14$"))).toEqual([
        "key_not_final_answer",
      ]);
    });

    it("does not flag an incomparable pair", () => {
      expect(codes(withOptions(["12 cm", "13 cm", "14 cm", "15 cm"], "13"))).toEqual([]);
    });

    it.each([
      ["a fraction in LaTeX", ["$x$", "$\frac{x}{2}$", "$2x$", "$3x$"], "x/2"],
      ["a braced exponent", ["$x$", "$x^{2}$", "$2x$", "$3x$"], "x^2"],
      ["a square root", ["$1$", "$\sqrt{2}$", "$3$", "$4$"], "sqrt(2)"],
      ["an equation with a trailing zero", ["x=3", "x=4", "x=5", "x=6"], "x=4.0"],
      ["a mixed number against a decimal", ["1/3", "$1 1/2$", "2", "3"], "1.5"],
      [
        "an option rounded to its own precision",
        ["6,5", "$7,33$", "8", "9"],
        "7.330382858",
      ],
    ] as const)("does not flag %s", (_name, texts, machine) => {
      const question = withOptions(
        [...texts] as [string, string, string, string],
        machine,
      );
      expect(codes(question)).toEqual([]);
    });

    it("flags two different plain words", () => {
      const question = withOptions(
        ["Segitiga sama kaki", "Segitiga siku-siku", "Segitiga lancip", "Persegi"],
        "Segitiga sama sisi",
      );
      expect(codes(question)).toEqual(["key_not_final_answer"]);
    });

    it("flags an option that is not the answer rounded to its precision", () => {
      const question = withOptions(["6,5", "$7,34$", "8", "9"], "7.330382858");
      expect(codes(question)).toEqual(["key_not_final_answer"]);
    });

    it("flags a second option that equals the answer while the marked one is not proven", () => {
      const question = withOptions(["12 cm", "13 cm", "14 cm", "13"], "13");
      expect(codes(question)).toEqual(["key_not_final_answer"]);
    });
  });

  describe("length_out_of_bounds", () => {
    const longText = (length: number) => "a".repeat(length);

    it("accepts the limit and rejects one over, for the stem", () => {
      expect(codes(make({ stem_md: longText(LENGTH_LIMITS.stem) }))).toEqual([]);
      expect(codes(make({ stem_md: longText(LENGTH_LIMITS.stem + 1) }))).toEqual([
        "length_out_of_bounds",
      ]);
    });

    it("applies the option limit", () => {
      const ok = withOptions(["5", longText(LENGTH_LIMITS.option), "7", "8"], "5", "A");
      const tooLong = withOptions(
        ["5", longText(LENGTH_LIMITS.option + 1), "7", "8"],
        "5",
        "A",
      );
      expect(codes(ok)).toEqual([]);
      expect(codes(tooLong)).toEqual(["length_out_of_bounds"]);
    });

    it("applies the explanation limit", () => {
      expect(
        codes(make({ explanation_md: longText(LENGTH_LIMITS.explanation) })),
      ).toEqual([]);
      expect(
        codes(make({ explanation_md: longText(LENGTH_LIMITS.explanation + 1) })),
      ).toEqual(["length_out_of_bounds"]);
    });

    it("applies the step length and step count limits", () => {
      const steps = (count: number, length = 10) =>
        Array.from({ length: count }, () => longText(length));
      expect(codes(make({ steps: steps(LENGTH_LIMITS.maxSteps) }))).toEqual([]);
      expect(codes(make({ steps: steps(LENGTH_LIMITS.maxSteps + 1) }))).toEqual([
        "length_out_of_bounds",
      ]);
      expect(codes(make({ steps: steps(2, LENGTH_LIMITS.step) }))).toEqual([]);
      expect(codes(make({ steps: steps(2, LENGTH_LIMITS.step + 1) }))).toEqual([
        "length_out_of_bounds",
      ]);
    });
  });

  it("returns several findings in a stable order", () => {
    const question = multipleChoiceQuestionSchema.parse({
      ...questionJson(3),
      stem_md: "a".repeat(LENGTH_LIMITS.stem + 1),
      options: [
        { label: "A", text_md: "5" },
        { label: "B", text_md: "5" },
        { label: "C", text_md: "7" },
        { label: "D", text_md: "8" },
      ],
      correctLabel: "C",
      answer: { display_md: "6", machine: "6" },
    });
    expect(codes(question)).toEqual([
      "options_not_distinct",
      "key_not_final_answer",
      "length_out_of_bounds",
    ]);
  });
});
