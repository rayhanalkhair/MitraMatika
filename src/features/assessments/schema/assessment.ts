import { z } from "zod";
import { err, ok, type Result } from "@/lib/result";
import { text } from "@/lib/forms/form-data";
import { parsePoints } from "../service/scoring";

// An assessment's own fields (decision 1) and the section title. Client-safe: no server code here.
// Scoring and the shuffle seed belong to Task 5.

export const ASSESSMENT_KINDS = [
  "latihan",
  "ulangan_harian",
  "sts",
  "sas",
  "custom",
] as const;
export type AssessmentKind = (typeof ASSESSMENT_KINDS)[number];
export const ASSESSMENT_GRADES = [7, 8, 9] as const;

export const ASSESSMENT_LIMITS = {
  title: 120,
  sectionTitle: 80,
  instructions: 2000,
  durationMinutes: 600,
} as const;

/** The title of the section every new assessment starts with (decision 2); stored text. */
export const DEFAULT_SECTION_TITLE = "A. Pilihan ganda";

export type AssessmentFieldErrorKey =
  "required" | "tooLong" | "invalidCharacters" | "invalid";

// C0 and C1 controls, line and paragraph separators, bidi controls. Line breaks and tabs are
// allowed in the instructions only.
const UNPRINTABLE = "\u2028\u2029\u202a-\u202e\u2066-\u2069";
const CONTROL = new RegExp(`[\u0000-\u001f\u007f-\u009f${UNPRINTABLE}]`);
const MULTILINE_CONTROL = new RegExp(
  `[\u0000-\u0008\u000b-\u001f\u007f-\u009f${UNPRINTABLE}]`,
);

const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1, { message: "required" })
    .max(max, { message: "tooLong" })
    .refine((value) => !CONTROL.test(value), { message: "invalidCharacters" });

export const sectionTitleSchema = singleLine(ASSESSMENT_LIMITS.sectionTitle);

const instructionsSchema = z
  .string()
  .transform((value) => value.replace(/\r\n?/g, "\n").trim())
  .pipe(
    z
      .string()
      .max(ASSESSMENT_LIMITS.instructions, { message: "tooLong" })
      .refine((value) => !MULTILINE_CONTROL.test(value), {
        message: "invalidCharacters",
      }),
  )
  .transform((value) => (value === "" ? null : value));

// A real calendar date, not just the right shape.
const dayOrNull = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .pipe(
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "invalid" })
      .refine(
        (value) => {
          const date = new Date(`${value}T12:00:00Z`);
          return (
            !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
          );
        },
        { message: "invalid" },
      )
      .nullable(),
  );

const durationOrNull = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .pipe(
    z
      .string()
      .regex(/^\d{1,3}$/, { message: "invalid" })
      .transform(Number)
      .refine((n) => n >= 1 && n <= ASSESSMENT_LIMITS.durationMinutes, {
        message: "invalid",
      })
      .nullable(),
  );

const uuidOrNull = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .pipe(z.uuid({ message: "invalid" }).nullable());

/**
 * The assessment form's values as the browser holds them: every field a string. A new assessment's
 * form shows the first four and posts nothing for the rest (read as blank).
 */
export interface AssessmentFormFields {
  title: string;
  kind: string;
  grade: string;
  templateId: string;
  examDate: string;
  durationMinutes: string;
  instructions: string;
}

export interface AssessmentInput {
  title: string;
  kind: AssessmentKind;
  grade: 7 | 8 | 9;
  templateId: string | null;
  examDate: string | null;
  durationMinutes: number | null;
  instructions: string | null;
}

const gradeSchema = z
  .string()
  .transform(Number)
  .pipe(z.literal([7, 8, 9], { message: "invalid" }));

const newAssessmentShape = {
  title: singleLine(ASSESSMENT_LIMITS.title),
  kind: z.string().pipe(z.enum(ASSESSMENT_KINDS, { message: "invalid" })),
  grade: gradeSchema,
  templateId: uuidOrNull,
};

/**
 * The details form's schema (title, type, grade, template, date, duration, instructions): the
 * browser validates with it (React Hook Form) and the Server Actions parse the posted FormData
 * with it (`parseAssessmentForm`). Issue paths are the field names, messages the error keys.
 */
export const updateAssessmentFormSchema: z.ZodType<
  AssessmentInput,
  AssessmentFormFields
> = z.object({
  ...newAssessmentShape,
  examDate: dayOrNull,
  durationMinutes: durationOrNull,
  instructions: instructionsSchema,
});

/**
 * The new-assessment form's schema: only the first four fields are checked, the rest are left
 * empty (the service stores them as such). Takes the same values as the details form.
 */
export const createAssessmentFormSchema: z.ZodType<
  AssessmentInput,
  AssessmentFormFields
> = z
  .object({
    ...newAssessmentShape,
    examDate: z.string(),
    durationMinutes: z.string(),
    instructions: z.string(),
  })
  .transform(({ title, kind, grade, templateId }): AssessmentInput => ({
    title,
    kind,
    grade,
    templateId,
    examDate: null,
    durationMinutes: null,
    instructions: null,
  }));

export type AssessmentField =
  | "title"
  | "kind"
  | "grade"
  | "templateId"
  | "examDate"
  | "durationMinutes"
  | "instructions";
export type AssessmentFieldErrors = Partial<
  Record<AssessmentField, AssessmentFieldErrorKey>
>;

/** A form-level message (assessments.errors). */
export type AssessmentFormErrorKey =
  | "generic"
  | "unauthenticated"
  | "notFound"
  | "conflict"
  | "approved"
  | "templateNotFound";

export interface AssessmentFormState {
  error?: AssessmentFormErrorKey;
  fieldErrors?: AssessmentFieldErrors;
  /** When the last save succeeded. */
  savedAt?: number;
  /** The row version the save produced, so the editor can keep its notice across the remount. */
  savedRowVersion?: number;
}

const FIELD_KEYS: readonly AssessmentFieldErrorKey[] = [
  "required",
  "tooLong",
  "invalidCharacters",
  "invalid",
];
export const asFieldKey = (message: string): AssessmentFieldErrorKey =>
  (FIELD_KEYS as readonly string[]).includes(message)
    ? (message as AssessmentFieldErrorKey)
    : "invalid";

/** What the browser would post, as the form's values (a missing field is blank). */
export function assessmentFormValues(data: FormData): AssessmentFormFields {
  return {
    title: text(data, "title"),
    kind: text(data, "kind"),
    grade: text(data, "grade"),
    templateId: text(data, "templateId"),
    examDate: text(data, "examDate"),
    durationMinutes: text(data, "durationMinutes"),
    instructions: text(data, "instructions"),
  };
}

const ASSESSMENT_FIELDS: readonly string[] = [
  "title",
  "kind",
  "grade",
  "templateId",
  "examDate",
  "durationMinutes",
  "instructions",
] satisfies AssessmentField[];
const isAssessmentField = (value: unknown): value is AssessmentField =>
  typeof value === "string" && ASSESSMENT_FIELDS.includes(value);

/** Reads the assessment form; each failing field comes back with its own error key. */
export function parseAssessmentForm(
  data: FormData,
): Result<AssessmentInput, AssessmentFieldErrors> {
  const parsed = updateAssessmentFormSchema.safeParse(assessmentFormValues(data));
  if (parsed.success) return ok(parsed.data);
  const errors: AssessmentFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (isAssessmentField(field)) errors[field] ??= asFieldKey(issue.message);
  }
  return err(Object.keys(errors).length > 0 ? errors : { title: "invalid" });
}

/** Parses a section title from a form value: the trimmed title, or null when it is not valid. */
export function parseSectionTitle(value: unknown): string | null {
  const parsed = sectionTitleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The points form's values: what the teacher typed per item, in the locale's notation. */
export interface PointsFormValues {
  points: Record<string, string>;
}

/**
 * The points form's schema, used by the browser (React Hook Form) and by `setPointsAction`: each
 * typed value goes through `parsePoints` ("2,5" and "2.5" both read as 2.5). A value that does not
 * parse is an `invalidPoints` issue on `points.<itemId>`; nothing is returned unless all do.
 */
export const pointsFormSchema: z.ZodType<Record<string, number>, PointsFormValues> = z
  .object({ points: z.record(z.string(), z.string()) })
  .transform(({ points }, ctx) => {
    const parsed: Record<string, number> = {};
    for (const [itemId, typed] of Object.entries(points)) {
      const value = parsePoints(typed);
      if (value === null) {
        ctx.addIssue({
          code: "custom",
          message: "invalidPoints",
          path: ["points", itemId],
        });
      } else {
        parsed[itemId] = value;
      }
    }
    return ctx.issues.length > 0 ? z.NEVER : parsed;
  });
