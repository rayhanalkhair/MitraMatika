import { describe, expect, it } from "vitest";
import { parseRequestSummary } from "./request-summary";

describe("parseRequestSummary", () => {
  it("reads the stored params", () => {
    expect(
      parseRequestSummary({
        grade: 8,
        topicTitle: "SPLDV",
        quantity: 3,
        difficulty: "sulit",
        topicId: "ignored",
      }),
    ).toEqual({ topicTitle: "SPLDV", quantity: 3, difficulty: "sulit" });
  });

  it.each([
    ["null", null],
    ["a string", "x"],
    ["missing title", { quantity: 3, difficulty: "sulit" }],
    ["a bad quantity", { topicTitle: "A", quantity: 9, difficulty: "sulit" }],
    ["a bad difficulty", { topicTitle: "A", quantity: 3, difficulty: "x" }],
  ])("returns null for %s", (_name, value) => {
    expect(parseRequestSummary(value)).toBeNull();
  });
});
