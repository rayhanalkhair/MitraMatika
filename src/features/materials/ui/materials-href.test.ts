import { describe, expect, it } from "vitest";
import { materialsHref } from "./materials-href";

const FOLDER = "11111111-1111-4111-8111-111111111111";

describe("materialsHref", () => {
  it("keeps the filters in a stable order and drops defaults", () => {
    expect(materialsHref({ page: 1 })).toBe("/materials");
    expect(
      materialsHref({ page: 1, q: "pecahan", grade: 8, folder: FOLDER, status: "ready" }),
    ).toBe(`/materials?folder=${FOLDER}&grade=8&status=ready&q=pecahan`);
  });

  it("starts a filter change at page 1 and keeps an explicit page", () => {
    expect(materialsHref({ page: 3, grade: 7 }, { year: "2026/2027" })).toBe(
      "/materials?grade=7&year=2026%2F2027",
    );
    expect(materialsHref({ page: 3, grade: 7 }, { page: 4 })).toBe(
      "/materials?grade=7&page=4",
    );
  });

  it("drops a param set to undefined", () => {
    expect(
      materialsHref({ page: 2, folder: FOLDER, q: "a" }, { folder: undefined }),
    ).toBe("/materials?q=a");
  });
});
