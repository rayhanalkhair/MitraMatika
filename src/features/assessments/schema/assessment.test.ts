import { zodResolver } from "@hookform/resolvers/zod";
import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_LIMITS,
  assessmentFormValues,
  createAssessmentFormSchema,
  parseAssessmentForm,
  pointsFormSchema,
  updateAssessmentFormSchema,
} from "./assessment";

const TEMPLATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASE = { title: "Ulangan SPLDV", kind: "sts", grade: "8", templateId: "" };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("assessmentFormValues", () => {
  it("reads every field as a string, a missing one as blank", () => {
    expect(assessmentFormValues(form(BASE))).toEqual({
      ...BASE,
      examDate: "",
      durationMinutes: "",
      instructions: "",
    });
  });
});

describe("createAssessmentFormSchema and updateAssessmentFormSchema", () => {
  const values = (fields: Record<string, string>) =>
    assessmentFormValues(form({ ...BASE, ...fields }));

  it("create mode validates four fields, edit mode seven", () => {
    const details = { durationMinutes: "0", examDate: "2026-02-30", instructions: "x" };
    const created = createAssessmentFormSchema.safeParse(values(details));
    expect(created.success && created.data).toEqual({
      title: "Ulangan SPLDV",
      kind: "sts",
      grade: 8,
      templateId: null,
      examDate: null,
      durationMinutes: null,
      instructions: null,
    });
    const updated = updateAssessmentFormSchema.safeParse(values(details));
    expect(updated.success).toBe(false);
    expect(
      !updated.success && updated.error.issues.map((issue) => issue.path[0]).sort(),
    ).toEqual(["durationMinutes", "examDate"]);
    // The first four are checked in both.
    expect(createAssessmentFormSchema.safeParse(values({ title: " " })).success).toBe(
      false,
    );
  });

  it("gives the details form's output: trimmed, numbers, nulls for blanks", () => {
    const result = updateAssessmentFormSchema.safeParse(
      values({
        title: "  Ulangan  ",
        templateId: TEMPLATE_ID,
        examDate: "2026-12-01",
        durationMinutes: " 60 ",
        instructions: "  Teliti.\r\nKerjakan.  ",
      }),
    );
    expect(result.success && result.data).toEqual({
      title: "Ulangan",
      kind: "sts",
      grade: 8,
      templateId: TEMPLATE_ID,
      examDate: "2026-12-01",
      durationMinutes: 60,
      instructions: "Teliti.\nKerjakan.",
    });
    expect(parseAssessmentForm(form(BASE)).ok).toBe(true);
  });
});

describe("client and server agree", () => {
  async function clientKeys(schema: typeof updateAssessmentFormSchema, data: FormData) {
    const resolved = await zodResolver(schema)(assessmentFormValues(data), undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });
    return Object.fromEntries(
      Object.entries(resolved.errors).map(([field, error]) => [
        field,
        (error as { message: string }).message,
      ]),
    );
  }
  function serverKeys(data: FormData) {
    const parsed = parseAssessmentForm(data);
    return parsed.ok ? {} : parsed.error;
  }

  it.each([
    ["an empty title", { ...BASE, title: " " }, { title: "required" }],
    [
      "a title over the limit",
      { ...BASE, title: "x".repeat(ASSESSMENT_LIMITS.title + 1) },
      { title: "tooLong" },
    ],
    ["an unknown kind", { ...BASE, kind: "ujian" }, { kind: "invalid" }],
    ["an unknown grade", { ...BASE, grade: "6" }, { grade: "invalid" }],
    [
      "a duration of 0",
      { ...BASE, durationMinutes: "0" },
      { durationMinutes: "invalid" },
    ],
    ["an impossible date", { ...BASE, examDate: "2026-02-30" }, { examDate: "invalid" }],
    [
      "an instruction over the limit",
      { ...BASE, instructions: "x".repeat(ASSESSMENT_LIMITS.instructions + 1) },
      { instructions: "tooLong" },
    ],
  ])("%s", async (_name, fields, expected) => {
    const data = form(fields);
    expect(await clientKeys(updateAssessmentFormSchema, data)).toEqual(expected);
    expect(serverKeys(data)).toEqual(expected);
  });

  it("the new-assessment form refuses the same title, kind and grade", async () => {
    const data = form({ ...BASE, title: "", grade: "6" });
    expect(await clientKeys(createAssessmentFormSchema, data)).toEqual({
      title: "required",
      grade: "invalid",
    });
    expect(serverKeys(data)).toEqual({ title: "required", grade: "invalid" });
  });
});

describe("pointsFormSchema", () => {
  it("reads both decimal notations", () => {
    const result = pointsFormSchema.safeParse({
      points: { a: "2,5", b: "2.5", c: " 3 " },
    });
    expect(result.success && result.data).toEqual({ a: 2.5, b: 2.5, c: 3 });
  });

  it("marks only the invalid item, with the invalidPoints key", () => {
    const result = pointsFormSchema.safeParse({ points: { a: "2", b: "abc", c: "0" } });
    expect(
      !result.success && result.error.issues.map((i) => [i.path, i.message]),
    ).toEqual([
      [["points", "b"], "invalidPoints"],
      [["points", "c"], "invalidPoints"],
    ]);
  });
});
