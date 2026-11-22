import { describe, expect, it } from "vitest";
import { LENGTH_LIMITS } from "@/features/generation";
import {
  EDIT_LIMITS,
  editFormSchema,
  editInputSchema,
  parseEditInput,
  type EditInput,
} from "./edit-input";

const valid: EditInput = {
  stemMd: "Hitung $1 + 1$.",
  options: [
    { label: "A", textMd: "1" },
    { label: "B", textMd: "2" },
    { label: "C", textMd: "3" },
    { label: "D", textMd: "4" },
  ],
  correctLabel: "B",
  answerDisplayMd: "2",
  explanationMd: "Jumlahkan.",
  steps: ["Tulis soalnya.", "Jumlahkan."],
};

describe("parseEditInput", () => {
  it("accepts a complete edit and trims the text", () => {
    const result = parseEditInput({ ...valid, stemMd: "  Hitung $1 + 1$.  " });
    expect(result).toEqual({ ok: true, value: valid });
  });

  it("drops blank steps", () => {
    const result = parseEditInput({ ...valid, steps: ["Satu.", "  ", "Dua."] });
    expect(result).toMatchObject({ ok: true, value: { steps: ["Satu.", "Dua."] } });
  });

  it("names the field that is empty", () => {
    const result = parseEditInput({
      ...valid,
      stemMd: " ",
      options: valid.options.map((o) => (o.label === "C" ? { ...o, textMd: "" } : o)),
    });
    expect(result).toEqual({ ok: false, fields: ["stemMd", "options.2.textMd"] });
  });

  it("requires four distinct labels and a key among them", () => {
    const dup = parseEditInput({
      ...valid,
      options: valid.options.map((o) => ({ ...o, label: "A" })),
    });
    expect(dup.ok).toBe(false);
    expect(parseEditInput({ ...valid, correctLabel: "E" }).ok).toBe(false);
  });

  it("requires the labels A to D in order", () => {
    const reversed = parseEditInput({ ...valid, options: [...valid.options].reverse() });
    expect(reversed.ok).toBe(false);
  });

  it("caps the number of step lines before blanks are dropped", () => {
    const many = parseEditInput({
      ...valid,
      steps: Array.from({ length: LENGTH_LIMITS.maxSteps * 4 + 1 }, () => ""),
    });
    expect(many.ok).toBe(false);
  });

  it("rejects text over the length limits, at the same limits as the structural check", () => {
    expect(EDIT_LIMITS).toEqual(LENGTH_LIMITS);
    const long = parseEditInput({ ...valid, stemMd: "x".repeat(LENGTH_LIMITS.stem + 1) });
    expect(long).toEqual({ ok: false, fields: ["stemMd"] });
    const steps = parseEditInput({
      ...valid,
      steps: Array.from({ length: LENGTH_LIMITS.maxSteps + 1 }, () => "x"),
    });
    expect(steps.ok).toBe(false);
  });

  it("rejects anything that is not an object", () => {
    expect(parseEditInput(null)).toEqual({ ok: false, fields: [] });
    expect(parseEditInput("x")).toEqual({ ok: false, fields: [] });
  });
});

const form = {
  ...valid,
  steps: [{ textMd: "Tulis soalnya." }, { textMd: "Jumlahkan." }],
};
const formFields = (input: unknown) => {
  const parsed = editFormSchema.safeParse(input);
  return parsed.success
    ? []
    : [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
};

describe("editInputSchema", () => {
  it("is the schema behind parseEditInput", () => {
    expect(editInputSchema.safeParse(valid).success).toBe(true);
    expect(editInputSchema.safeParse({ ...valid, stemMd: "" }).success).toBe(false);
  });
});

describe("editFormSchema", () => {
  it("turns the step rows into the steps of an EditInput, trimmed, blanks dropped", () => {
    const result = editFormSchema.safeParse({
      ...form,
      stemMd: "  Hitung $1 + 1$.  ",
      steps: [{ textMd: " Tulis soalnya. " }, { textMd: "  " }, { textMd: "Jumlahkan." }],
    });
    expect(result).toMatchObject({ success: true, data: valid });
  });

  it("accepts no steps", () => {
    expect(editFormSchema.safeParse({ ...form, steps: [] })).toMatchObject({
      success: true,
      data: { steps: [] },
    });
  });

  it("names the invalid fields by the form's own paths", () => {
    expect(
      formFields({
        ...form,
        stemMd: " ",
        options: form.options.map((o) => (o.label === "C" ? { ...o, textMd: "" } : o)),
        steps: [{ textMd: "ok" }, { textMd: "x".repeat(EDIT_LIMITS.step + 1) }],
      }),
    ).toEqual(["stemMd", "options.2.textMd", "steps.1.textMd"]);
  });

  it("refuses more steps than the limit once blanks are dropped, and a flat step list", () => {
    const many = Array.from({ length: EDIT_LIMITS.maxSteps + 1 }, () => ({
      textMd: "x",
    }));
    expect(formFields({ ...form, steps: many })).toEqual(["steps"]);
    expect(editFormSchema.safeParse(valid).success).toBe(false);
  });

  it("refuses the same labels and keys as the server schema", () => {
    expect(editFormSchema.safeParse({ ...form, correctLabel: "E" }).success).toBe(false);
    expect(
      editFormSchema.safeParse({ ...form, options: [...form.options].reverse() }).success,
    ).toBe(false);
  });
});
