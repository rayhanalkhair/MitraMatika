import { describe, expect, it } from "vitest";
import {
  confirmStructureSchema,
  MAX_CHAPTERS,
  structureFormSchema,
  type StructureFormValues,
} from "./structure";

const TOPIC = "99999999-9999-4999-8999-999999999999";
const VALID: StructureFormValues = {
  title: "  Matematika  ",
  grade: "8",
  academicYear: " 2026/2027 ",
  chapters: [
    { title: "Bab 1", pageStart: "1", pageEnd: "4", topicId: "" },
    { title: "Bab 2", pageStart: "5", pageEnd: "9", topicId: TOPIC },
  ],
};

function issues(values: unknown) {
  const result = structureFormSchema.safeParse(values);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
}

describe("structureFormSchema", () => {
  it("turns the typed strings into the confirmation input", () => {
    expect(structureFormSchema.parse(VALID)).toEqual({
      title: "Matematika",
      grade: 8,
      academicYear: "2026/2027",
      chapters: [
        { title: "Bab 1", pageStart: 1, pageEnd: 4, topicId: null },
        { title: "Bab 2", pageStart: 5, pageEnd: 9, topicId: TOPIC },
      ],
    });
  });

  it("reads blank grade and academic year as none, and allows no chapters", () => {
    expect(
      structureFormSchema.parse({
        ...VALID,
        grade: "",
        academicYear: "  ",
        chapters: [],
      }),
    ).toEqual({ title: "Matematika", grade: null, academicYear: null, chapters: [] });
  });

  it("agrees with the confirmation schema on the same values", () => {
    const asInput = {
      title: "Matematika",
      grade: 8,
      academicYear: "2026/2027",
      chapters: [{ title: "Bab 1", pageStart: 1, pageEnd: 4, topicId: null }],
    };
    expect(confirmStructureSchema.parse({ materialId: TOPIC, ...asInput })).toEqual({
      materialId: TOPIC,
      ...asInput,
    });
    expect(
      structureFormSchema.parse({
        title: "Matematika",
        grade: "8",
        academicYear: "2026/2027",
        chapters: [{ title: "Bab 1", pageStart: "1", pageEnd: "4", topicId: "" }],
      }),
    ).toEqual(asInput);
  });

  it.each([
    ["an empty title", { ...VALID, title: "  " }, "title"],
    ["a title over the limit", { ...VALID, title: "x".repeat(201) }, "title"],
    ["a bad academic year", { ...VALID, academicYear: "2026/2030" }, "academicYear"],
    ["a grade outside 7 to 9", { ...VALID, grade: "10" }, "grade"],
    ["a grade that is not a number", { ...VALID, grade: "abc" }, "grade"],
    [
      "a page end before the start",
      {
        ...VALID,
        chapters: [{ title: "Bab", pageStart: "5", pageEnd: "2", topicId: "" }],
      },
      "chapters.0.pageEnd",
    ],
    [
      "an empty page",
      {
        ...VALID,
        chapters: [{ title: "Bab", pageStart: "", pageEnd: "2", topicId: "" }],
      },
      "chapters.0.pageStart",
    ],
    [
      "a fractional page",
      {
        ...VALID,
        chapters: [{ title: "Bab", pageStart: "1.5", pageEnd: "2", topicId: "" }],
      },
      "chapters.0.pageStart",
    ],
    [
      "a page written as hex",
      {
        ...VALID,
        chapters: [{ title: "Bab", pageStart: "0x10", pageEnd: "20", topicId: "" }],
      },
      "chapters.0.pageStart",
    ],
    [
      "an empty chapter title",
      { ...VALID, chapters: [{ title: " ", pageStart: "1", pageEnd: "2", topicId: "" }] },
      "chapters.0.title",
    ],
    [
      "a topic that is not an id",
      {
        ...VALID,
        chapters: [{ title: "Bab", pageStart: "1", pageEnd: "2", topicId: "x" }],
      },
      "chapters.0.topicId",
    ],
  ])(
    "refuses %s at its field, with the editor's one error key",
    (_name, values, path) => {
      const found = issues(values);
      expect(found.map((issue) => issue.path)).toContain(path);
      expect(new Set(found.map((issue) => issue.message))).toEqual(new Set(["invalid"]));
    },
  );

  it("refuses more than the chapter limit", () => {
    const chapters = Array.from({ length: MAX_CHAPTERS + 1 }, () => ({
      title: "Bab",
      pageStart: "1",
      pageEnd: "2",
      topicId: "",
    }));
    expect(issues({ ...VALID, chapters }).length).toBeGreaterThan(0);
  });

  it("refuses values of the wrong shape", () => {
    expect(issues(null).length).toBeGreaterThan(0);
    expect(issues({ ...VALID, chapters: "x" }).length).toBeGreaterThan(0);
    expect(issues({ ...VALID, title: 5 }).length).toBeGreaterThan(0);
  });
});
