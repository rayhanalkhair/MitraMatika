import { describe, expect, it } from "vitest";
import { generationParamsSchema } from "./request-params";

const valid = {
  grade: 8,
  topicId: "44444444-4444-4444-8444-444444444444",
  topicStableKey: "spldv",
  topicTitle: "SPLDV",
  curriculumVersionId: "33333333-3333-4333-8333-333333333333",
  type: "multiple_choice",
  quantity: 5,
  difficulty: "sedang",
};

describe("generationParamsSchema", () => {
  it("accepts the shape the create-request action writes", () => {
    expect(generationParamsSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ["grade 7", { grade: 7 }],
    ["quantity 0", { quantity: 0 }],
    ["quantity 6", { quantity: 6 }],
    ["fractional quantity", { quantity: 2.5 }],
    ["unknown difficulty", { difficulty: "gampang" }],
    ["other question type", { type: "essay" }],
    ["topic id that is not a uuid", { topicId: "spldv" }],
    ["missing version", { curriculumVersionId: undefined }],
  ])("rejects %s", (_name, patch) => {
    expect(generationParamsSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it("rejects the empty params of a request created by hand", () => {
    expect(generationParamsSchema.safeParse({}).success).toBe(false);
  });
});
