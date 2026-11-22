import { describe, expect, it } from "vitest";
import { batchJson, questionJson, solverJson } from "./fixtures";
import * as support from "./test-support";

describe("fixtures", () => {
  it("builds a batch of valid-shaped questions", () => {
    const parsed = JSON.parse(batchJson(3, "sulit")) as {
      questions: { metadata: { difficulty: string }; answer: { machine: string } }[];
    };
    expect(parsed.questions).toHaveLength(3);
    expect(parsed.questions[0].metadata.difficulty).toBe("sulit");
    expect(parsed.questions[1].answer.machine).toBe("4");
  });

  it("builds a solver answer", () => {
    expect(solverJson("B", "4")).toEqual({
      correctLabel: "B",
      answer: { display_md: "4", machine: "4" },
      steps: ["Tulis soalnya.", "Hitung hasilnya."],
    });
  });

  it("is re-exported by test-support", () => {
    expect(support.batchJson).toBe(batchJson);
    expect(support.questionJson).toBe(questionJson);
    expect(support.solverJson).toBe(solverJson);
  });
});
