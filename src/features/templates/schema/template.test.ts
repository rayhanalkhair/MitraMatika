import { zodResolver } from "@hookform/resolvers/zod";
import { describe, expect, it } from "vitest";
import {
  parseTemplateForm,
  TEMPLATE_LIMITS,
  templateFormSchema,
  templateFormValues,
  templateSchema,
  type TemplateInput,
} from "./template";

const VALID: TemplateInput = {
  name: "Kop utama",
  schoolName: "SMP Negeri 1 Surabaya",
  headerLines: ["Pemerintah Kota Surabaya", "Dinas Pendidikan"],
  subject: "Matematika",
  studentFields: ["name", "class"],
  defaultInstructions: null,
  paperSize: "A4",
  font: "times",
  isDefault: false,
};

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(name, item);
  }
  return data;
}

describe("templateSchema", () => {
  it("accepts a full template and trims every text", () => {
    const parsed = templateSchema.parse({
      ...VALID,
      name: "  Kop utama ",
      schoolName: " SMP Negeri 1 Surabaya ",
      headerLines: ["  Dinas Pendidikan  "],
      defaultInstructions: "  Kerjakan dengan teliti.\r\nTulis nama.  ",
    });
    expect(parsed.name).toBe("Kop utama");
    expect(parsed.schoolName).toBe("SMP Negeri 1 Surabaya");
    expect(parsed.headerLines).toEqual(["Dinas Pendidikan"]);
    // Line breaks are kept (normalised), only the ends are trimmed.
    expect(parsed.defaultInstructions).toBe("Kerjakan dengan teliti.\nTulis nama.");
  });

  it("defaults the subject to Matematika, the paper to A4 and the font to Times", () => {
    const parsed = templateSchema.parse({
      name: "Kop",
      schoolName: "SMP 2",
      headerLines: [],
      studentFields: [],
    });
    expect(parsed).toMatchObject({
      subject: "Matematika",
      paperSize: "A4",
      font: "times",
      isDefault: false,
      defaultInstructions: null,
    });
  });

  it("enforces the length limits of decision 7", () => {
    const tooLong = (n: number) => "x".repeat(n + 1);
    for (const input of [
      { ...VALID, name: tooLong(TEMPLATE_LIMITS.name) },
      { ...VALID, schoolName: tooLong(TEMPLATE_LIMITS.schoolName) },
      { ...VALID, headerLines: [tooLong(TEMPLATE_LIMITS.headerLine)] },
      { ...VALID, subject: tooLong(TEMPLATE_LIMITS.subject) },
      { ...VALID, defaultInstructions: tooLong(TEMPLATE_LIMITS.instructions) },
    ]) {
      expect(
        templateSchema.safeParse(input).success,
        JSON.stringify(input).slice(0, 60),
      ).toBe(false);
    }
    // Exactly at the limit is fine.
    expect(
      templateSchema.safeParse({
        ...VALID,
        name: "x".repeat(TEMPLATE_LIMITS.name),
        schoolName: "x".repeat(TEMPLATE_LIMITS.schoolName),
        headerLines: Array(4).fill("x".repeat(TEMPLATE_LIMITS.headerLine)),
      }).success,
    ).toBe(true);
  });

  it("allows at most 4 header lines and no blank one", () => {
    expect(
      templateSchema.safeParse({ ...VALID, headerLines: ["a", "b", "c", "d", "e"] })
        .success,
    ).toBe(false);
    expect(
      templateSchema.safeParse({ ...VALID, headerLines: ["a", "   "] }).success,
    ).toBe(false);
  });

  it("requires a template name and a school name", () => {
    expect(templateSchema.safeParse({ ...VALID, name: "   " }).success).toBe(false);
    expect(templateSchema.safeParse({ ...VALID, schoolName: "" }).success).toBe(false);
  });

  it("rejects control characters, also in the instructions (line breaks and tabs aside)", () => {
    expect(templateSchema.safeParse({ ...VALID, name: "Kop\u0000" }).success).toBe(false);
    expect(
      templateSchema.safeParse({ ...VALID, schoolName: "SMP\u001b[31m" }).success,
    ).toBe(false);
    expect(templateSchema.safeParse({ ...VALID, headerLines: ["a\nb"] }).success).toBe(
      false,
    );
    expect(templateSchema.safeParse({ ...VALID, subject: "Mat\u0085" }).success).toBe(
      false,
    );
    expect(
      templateSchema.safeParse({ ...VALID, defaultInstructions: "a\u0007b" }).success,
    ).toBe(false);
    expect(
      templateSchema.safeParse({ ...VALID, defaultInstructions: "1.\tSatu\n2.\tDua" })
        .success,
    ).toBe(true);
  });

  it("rejects line and paragraph separators and bidi controls that would reorder printed text", () => {
    // Built from code points so the source stays free of invisible characters.
    for (const code of [0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069]) {
      const char = String.fromCharCode(code);
      expect(
        templateSchema.safeParse({ ...VALID, schoolName: `SMP${char}2` }).success,
        code.toString(16),
      ).toBe(false);
      expect(
        templateSchema.safeParse({ ...VALID, defaultInstructions: `a${char}b` }).success,
        code.toString(16),
      ).toBe(false);
    }
  });

  it("only knows the four student fields, A4 or F4, and Times or Arial", () => {
    expect(templateSchema.safeParse({ ...VALID, studentFields: ["nisn"] }).success).toBe(
      false,
    );
    expect(templateSchema.safeParse({ ...VALID, paperSize: "Letter" }).success).toBe(
      false,
    );
    expect(templateSchema.safeParse({ ...VALID, font: "calibri" }).success).toBe(false);
    expect(
      templateSchema.parse({ ...VALID, studentFields: ["date", "name", "date"] })
        .studentFields,
    ).toEqual(["name", "date"]);
  });
});

describe("parseTemplateForm", () => {
  it("reads the form, drops blank header lines and keeps the toggles", () => {
    const parsed = parseTemplateForm(
      form({
        name: "Kop utama",
        schoolName: "SMP 2",
        headerLine0: "Pemerintah Kota",
        headerLine1: "   ",
        headerLine2: "Jl. Merdeka 1",
        headerLine3: "",
        subject: "",
        studentFields: ["name", "number"],
        defaultInstructions: "",
        paperSize: "F4",
        font: "arial",
        isDefault: "on",
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      data: {
        name: "Kop utama",
        schoolName: "SMP 2",
        headerLines: ["Pemerintah Kota", "Jl. Merdeka 1"],
        subject: "Matematika",
        studentFields: ["name", "number"],
        defaultInstructions: null,
        paperSize: "F4",
        font: "arial",
        isDefault: true,
      },
    });
  });

  it("names the field of each problem, the header line by its own input", () => {
    const parsed = parseTemplateForm(
      form({
        name: "",
        schoolName: "s".repeat(TEMPLATE_LIMITS.schoolName + 1),
        headerLine2: "x".repeat(TEMPLATE_LIMITS.headerLine + 1),
        paperSize: "A3",
        font: "times",
      }),
    );
    expect(parsed).toEqual({
      ok: false,
      error: {
        name: "required",
        schoolName: "tooLong",
        headerLine2: "tooLong",
        paperSize: "invalid",
      },
    });
  });
});

describe("templateFormSchema: client and server agree", () => {
  const BASE = { name: "Kop utama", schoolName: "SMP 2", paperSize: "A4", font: "times" };

  // What the browser's resolver says per field, as message keys.
  async function clientKeys(data: FormData) {
    const resolved = await zodResolver(templateFormSchema)(
      templateFormValues(data),
      undefined,
      { fields: {}, shouldUseNativeValidation: false },
    );
    return Object.fromEntries(
      Object.entries(resolved.errors).map(([field, error]) => [
        field,
        (error as { message: string }).message,
      ]),
    );
  }
  function serverKeys(data: FormData) {
    const parsed = parseTemplateForm(data);
    return parsed.ok ? {} : parsed.error;
  }

  it.each([
    ["an empty name", { ...BASE, name: "" }, { name: "required" }],
    [
      "a header line over the limit",
      { ...BASE, headerLine1: "x".repeat(TEMPLATE_LIMITS.headerLine + 1) },
      { headerLine1: "tooLong" },
    ],
    ["an unknown paper size", { ...BASE, paperSize: "A3" }, { paperSize: "invalid" }],
    ["an unknown font", { ...BASE, font: "comic" }, { font: "invalid" }],
    [
      "an unknown student field",
      { ...BASE, studentFields: ["name", "grade"] },
      { studentFields: "invalid" },
    ],
    [
      "a control character in the school name",
      { ...BASE, schoolName: "SMP\u0007 2" },
      { schoolName: "invalidCharacters" },
    ],
  ])("%s", async (_name, fields, expected) => {
    const data = form(fields);
    expect(await clientKeys(data)).toEqual(expected);
    expect(serverKeys(data)).toEqual(expected);
  });

  it("gives the same output as the server parse, blank header lines dropped", () => {
    const data = form({
      ...BASE,
      headerLine0: "  Dinas  ",
      headerLine1: " ",
      headerLine3: "Jl. Merdeka 1",
      studentFields: ["number", "name"],
      isDefault: "on",
    });
    const result = templateFormSchema.safeParse(templateFormValues(data));
    expect(result.success && result.data).toEqual({
      name: "Kop utama",
      schoolName: "SMP 2",
      headerLines: ["Dinas", "Jl. Merdeka 1"],
      subject: "Matematika",
      studentFields: ["name", "number"],
      defaultInstructions: null,
      paperSize: "A4",
      font: "times",
      isDefault: true,
    });
    expect(parseTemplateForm(data).ok).toBe(true);
  });

  it("reads every visible field as a string and the toggles as booleans", () => {
    expect(
      templateFormValues(
        form({ ...BASE, headerLine2: "Jl. 1", studentFields: ["name"], isDefault: "on" }),
      ),
    ).toEqual({
      name: "Kop utama",
      schoolName: "SMP 2",
      headerLine0: "",
      headerLine1: "",
      headerLine2: "Jl. 1",
      headerLine3: "",
      subject: "",
      studentFields: ["name"],
      defaultInstructions: "",
      paperSize: "A4",
      font: "times",
      isDefault: true,
    });
  });
});

describe("templateFormSchema and templateSchema agree", () => {
  // The service stores what templateSchema returns, the form what templateFormSchema returns:
  // on the same input they must accept or refuse together, and give the same value.
  const CASES: [string, Record<string, string | string[]>][] = [
    [
      "a minimal template",
      { name: "Kop", schoolName: "SMP 2", paperSize: "A4", font: "times" },
    ],
    [
      "a full template",
      {
        name: "  Kop utama  ",
        schoolName: "SMP Negeri 1",
        headerLine0: "Dinas",
        headerLine2: " Jl. Merdeka 1 ",
        subject: " Fisika ",
        studentFields: ["date", "name"],
        defaultInstructions: "  Kerjakan dengan jujur.\r\nBerdoalah.  ",
        paperSize: "F4",
        font: "arial",
        isDefault: "on",
      },
    ],
    [
      "a blank subject",
      { name: "Kop", schoolName: "SMP 2", subject: "  ", paperSize: "A4", font: "times" },
    ],
    ["an empty name", { name: "", schoolName: "SMP 2", paperSize: "A4", font: "times" }],
    [
      "a long school name",
      { name: "Kop", schoolName: "x".repeat(121), paperSize: "A4", font: "times" },
    ],
    [
      "an unknown font",
      { name: "Kop", schoolName: "SMP 2", paperSize: "A4", font: "comic" },
    ],
    [
      "a control character in the instructions",
      {
        name: "Kop",
        schoolName: "SMP 2",
        defaultInstructions: "a" + String.fromCharCode(7),
        paperSize: "A4",
        font: "times",
      },
    ],
  ];

  it.each(CASES)("%s", (_name, fields) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      for (const v of Array.isArray(value) ? value : [value]) data.append(key, v);
    }
    const values = templateFormValues(data);
    const viaForm = templateFormSchema.safeParse(values);
    const viaService = templateSchema.safeParse({
      name: values.name,
      schoolName: values.schoolName,
      headerLines: [
        values.headerLine0,
        values.headerLine1,
        values.headerLine2,
        values.headerLine3,
      ].filter((line) => line.trim() !== ""),
      subject: values.subject.trim() === "" ? undefined : values.subject,
      studentFields: values.studentFields,
      defaultInstructions: values.defaultInstructions,
      paperSize: values.paperSize,
      font: values.font,
      isDefault: values.isDefault,
    });
    expect(viaForm.success).toBe(viaService.success);
    if (viaForm.success && viaService.success) {
      expect(viaForm.data).toEqual(viaService.data);
    }
  });
});
