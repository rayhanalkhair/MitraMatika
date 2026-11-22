import { describe, expect, it } from "vitest";
import { parsePageList } from "./material-selection";
import { parseGenerationInput } from "./request-input";

const MATERIAL = "55555555-5555-4555-8555-555555555555";
const SECTION = "66666666-6666-4666-8666-666666666666";

const form = (fields: [string, string][]) => {
  const data = new FormData();
  for (const [key, value] of fields) data.append(key, value);
  return data;
};
const base: [string, string][] = [
  ["grade", "8"],
  ["topic", "spldv"],
  ["count", "2"],
  ["difficulty", "mudah"],
];

describe("parseGenerationInput with a material source", () => {
  it("keeps the topic-only shape when the source is the topic", () => {
    expect(parseGenerationInput(form([...base, ["source", "topic"]]))).toEqual({
      ok: true,
      value: { topic: "spldv", count: 2, difficulty: "mudah" },
    });
  });

  it("reads the whole document, chapters or a page list", () => {
    const pick = (fields: [string, string][]) =>
      parseGenerationInput(
        form([...base, ["source", "material"], ["materialId", MATERIAL], ...fields]),
      );
    expect(pick([["materialScope", "all"]])).toEqual({
      ok: true,
      value: {
        topic: "spldv",
        count: 2,
        difficulty: "mudah",
        material: { materialId: MATERIAL, scope: "all" },
      },
    });
    expect(
      pick([
        ["materialScope", "sections"],
        ["sectionIds", SECTION],
      ]),
    ).toMatchObject({
      ok: true,
      value: {
        material: { materialId: MATERIAL, scope: "sections", sectionIds: [SECTION] },
      },
    });
    expect(
      pick([
        ["materialScope", "pages"],
        ["pages", "3-5, 1"],
      ]),
    ).toMatchObject({
      ok: true,
      value: { material: { materialId: MATERIAL, scope: "pages", pages: [1, 3, 4, 5] } },
    });
  });

  it("says what is missing", () => {
    const material = (fields: [string, string][]) =>
      parseGenerationInput(form([...base, ["source", "material"], ...fields]));
    expect(material([])).toEqual({ ok: false, errors: { material: "materialMissing" } });
    expect(
      material([
        ["materialId", MATERIAL],
        ["materialScope", "sections"],
      ]),
    ).toEqual({ ok: false, errors: { material: "sectionsMissing" } });
    expect(
      material([
        ["materialId", MATERIAL],
        ["materialScope", "pages"],
        ["pages", "5-2"],
      ]),
    ).toEqual({ ok: false, errors: { material: "pagesInvalid" } });
  });
});

describe("parsePageList", () => {
  it("reads pages and ranges, sorted without duplicates", () => {
    expect(parsePageList("2, 4-6 4")).toEqual([2, 4, 5, 6]);
    expect(parsePageList("7–8")).toEqual([7, 8]);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "0", "3-1", "a", "1-301", "2,,x"]) {
      expect(parsePageList(bad)).toBeNull();
    }
  });
});
