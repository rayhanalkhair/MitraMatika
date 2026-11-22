import { zodResolver } from "@hookform/resolvers/zod";
import { describe, expect, it } from "vitest";
import {
  generationFormSchema,
  generationFormValues,
  parseGenerationInput,
} from "./request-input";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
};

describe("parseGenerationInput", () => {
  it("accepts a valid submission", () => {
    expect(
      parseGenerationInput(
        form({ grade: "8", topic: "spldv", count: "3", difficulty: "sulit" }),
      ),
    ).toEqual({
      ok: true,
      value: { topic: "spldv", count: 3, difficulty: "sulit" },
    });
  });

  it("defaults the quantity to 5 and the difficulty to sedang when absent", () => {
    expect(parseGenerationInput(form({ grade: "8", topic: "spldv" }))).toEqual({
      ok: true,
      value: { topic: "spldv", count: 5, difficulty: "sedang" },
    });
  });

  it("trims the topic key", () => {
    const result = parseGenerationInput(form({ grade: "8", topic: "  spldv  " }));
    expect(result).toMatchObject({ ok: true, value: { topic: "spldv" } });
  });

  it.each([
    ["a missing topic", { grade: "8" }, "topic"],
    ["a blank topic", { grade: "8", topic: "   " }, "topic"],
    ["an over-long topic", { grade: "8", topic: "x".repeat(101) }, "topic"],
    ["another grade", { grade: "7", topic: "a" }, "grade"],
    ["a missing grade", { topic: "a" }, "grade"],
    ["quantity 0", { grade: "8", topic: "a", count: "0" }, "count"],
    ["quantity 6", { grade: "8", topic: "a", count: "6" }, "count"],
    ["a fractional quantity", { grade: "8", topic: "a", count: "2.5" }, "count"],
    ["a non-numeric quantity", { grade: "8", topic: "a", count: "abc" }, "count"],
    [
      "an unknown difficulty",
      { grade: "8", topic: "a", difficulty: "gila" },
      "difficulty",
    ],
  ])("rejects %s with a message on %s", (_name, fields, field) => {
    const result = parseGenerationInput(form(fields));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field as "topic"]).toEqual(expect.any(String));
  });

  it("reports several errors at once", () => {
    const result = parseGenerationInput(
      form({ grade: "8", count: "9", difficulty: "x" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["count", "difficulty", "topic"]);
    }
  });
});

describe("generationFormSchema: client and server agree", () => {
  const MATERIAL = "55555555-5555-4555-8555-555555555555";
  const formOf = (fields: [string, string][]) => {
    const data = new FormData();
    for (const [key, value] of fields) data.append(key, value);
    return data;
  };
  // The browser: React Hook Form's resolver over the raw values (first error per path).
  async function clientKeys(data: FormData) {
    const { errors } = await zodResolver(generationFormSchema)(
      generationFormValues(data),
      undefined,
      { fields: {}, shouldUseNativeValidation: false },
    );
    return Object.fromEntries(
      Object.entries(errors).map(([name, error]) => [name, String(error.message)]),
    );
  }
  function serverKeys(data: FormData) {
    const result = parseGenerationInput(data);
    return result.ok ? {} : result.errors;
  }

  it.each<[string, [string, string][], Record<string, string>]>([
    ["no topic", [["grade", "8"]], { topic: "topik" }],
    [
      "count 6",
      [
        ["grade", "8"],
        ["topic", "a"],
        ["count", "6"],
      ],
      { count: "jumlah" },
    ],
    [
      "difficulty x",
      [
        ["grade", "8"],
        ["topic", "a"],
        ["difficulty", "x"],
      ],
      { difficulty: "kesulitan" },
    ],
    [
      "a material with chapters and none checked",
      [
        ["grade", "8"],
        ["topic", "a"],
        ["source", "material"],
        ["materialId", MATERIAL],
        ["materialScope", "sections"],
      ],
      { material: "sectionsMissing" },
    ],
    [
      "pages 3-1",
      [
        ["grade", "8"],
        ["topic", "a"],
        ["source", "material"],
        ["materialId", MATERIAL],
        ["materialScope", "pages"],
        ["pages", "3-1"],
      ],
      { material: "pagesInvalid" },
    ],
    [
      "no topic and no material",
      [
        ["grade", "8"],
        ["source", "material"],
      ],
      { topic: "topik", material: "materialMissing" },
    ],
  ])("%s", async (_name, fields, expected) => {
    const data = formOf(fields);
    expect(await clientKeys(data)).toEqual(expected);
    expect(serverKeys(data)).toEqual(expected);
  });

  it("ignores the material fields when the source is the topic", () => {
    const values = {
      grade: "8",
      topic: "spldv",
      count: "2",
      difficulty: "mudah",
      source: "topic" as const,
      materialId: "",
      materialScope: "pages" as const,
      sectionIds: [],
      pages: "3-1",
    };
    expect(generationFormSchema.safeParse(values)).toEqual({
      success: true,
      data: { topic: "spldv", count: 2, difficulty: "mudah" },
    });
  });

  it("reads the posted values with the defaults the form starts from", () => {
    expect(generationFormValues(formOf([["topic", "spldv"]]))).toEqual({
      grade: "",
      topic: "spldv",
      count: "5",
      difficulty: "sedang",
      source: "topic",
      materialId: "",
      materialScope: "all",
      sectionIds: [],
      pages: "",
    });
  });
});
