import { describe, expect, it } from "vitest";
import { bankQuerySchema } from "../schema/bank-query";
import { bankHref, bankParams, hasActiveFilters } from "./bank-href";

const parse = (raw: Record<string, string>) => bankQuerySchema.parse(raw);

describe("bankHref", () => {
  it("is the bare path for the default view", () => {
    expect(bankHref(parse({}))).toBe("/question-bank");
    expect(hasActiveFilters(parse({}))).toBe(false);
  });

  it("keeps filters and sort, drops defaults, and goes back to page 1 on a change", () => {
    const query = parse({ grade: "8", q: "luas", sort: "oldest", page: "3" });
    expect(bankHref(query, { grade: undefined })).toBe(
      "/question-bank?q=luas&sort=oldest",
    );
    expect(bankHref(query, { page: 2 })).toBe(
      "/question-bank?grade=8&q=luas&sort=oldest&page=2",
    );
    expect(bankHref(query, { difficulty: "sulit" })).toBe(
      "/question-bank?grade=8&difficulty=sulit&q=luas&sort=oldest",
    );
  });

  it("lists params except the ones the caller supplies", () => {
    const query = parse({ grade: "7", q: "x", page: "2" });
    expect(bankParams(query, ["q", "page"])).toEqual([["grade", "7"]]);
  });
});
