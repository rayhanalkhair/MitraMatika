import { describe, expect, it } from "vitest";
import { bankQuerySchema } from "./bank-query";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("bankQuerySchema", () => {
  it("defaults to newest, page 1 and no filters", () => {
    expect(bankQuerySchema.parse({})).toEqual({ sort: "newest", page: 1 });
  });

  it("parses every URL param", () => {
    expect(
      bankQuerySchema.parse({
        grade: "8",
        topicId: UUID,
        elementId: UUID,
        difficulty: "sulit",
        type: "multiple_choice",
        status: "terverifikasi",
        origin: "generated",
        from: "2026-11-01",
        to: "2026-11-30",
        q: " spldv ",
        sort: "difficulty",
        page: "3",
      }),
    ).toEqual({
      grade: 8,
      topicId: UUID,
      elementId: UUID,
      difficulty: "sulit",
      type: "multiple_choice",
      status: "terverifikasi",
      origin: "generated",
      from: "2026-11-01",
      to: "2026-11-30",
      q: "spldv",
      sort: "difficulty",
      page: 3,
    });
  });

  it("falls back to the defaults for invalid params instead of failing", () => {
    expect(
      bankQuerySchema.parse({
        grade: "6",
        topicId: "nope",
        difficulty: "gampang",
        status: "x",
        from: "yesterday",
        sort: "random",
        page: "0",
      }),
    ).toEqual({ sort: "newest", page: 1 });
    expect(bankQuerySchema.parse({ page: "abc", q: "   " })).toEqual({
      sort: "newest",
      page: 1,
    });
  });

  it("cuts a query longer than 100 characters instead of dropping it", () => {
    expect(bankQuerySchema.parse({ q: `${"a".repeat(100)}bcd` }).q).toBe("a".repeat(100));
  });

  it("takes the first value of a repeated param", () => {
    expect(bankQuerySchema.parse({ grade: ["9", "7"], page: ["2", "5"] })).toEqual({
      grade: 9,
      sort: "newest",
      page: 2,
    });
  });

  it("drops dates that have the right shape but are not real days", () => {
    const parsed = bankQuerySchema.parse({ from: "2026-99-99", to: "2026-02-31" });
    expect(parsed.from).toBeUndefined();
    expect(parsed.to).toBeUndefined();
  });
});
