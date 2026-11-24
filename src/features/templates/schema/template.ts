import { z } from "zod";
import { err, ok, type Result } from "@/lib/result";
import { text, texts } from "@/lib/forms/form-data";

// The school document template (decision 7): the letterhead and print settings of the question
// paper, answer key and solutions. Read in the Server Action with parseTemplateForm; the service
// stores what templateSchema returns. Client-safe: no server code here.

export const TEMPLATE_LIMITS = {
  name: 80,
  schoolName: 120,
  headerLine: 120,
  headerLines: 4,
  subject: 60,
  instructions: 2000,
} as const;

/** A logo upload may be at most 1 MiB (decision 7: up to 1 MB). */
export const MAX_LOGO_BYTES = 1024 * 1024;
/** The longest side a raster logo may claim in its header, in pixels. */
export const MAX_LOGO_SIDE = 6000;
export const LOGO_ACCEPT = "image/png,image/jpeg";

export const STUDENT_FIELDS = ["name", "class", "number", "date"] as const;
export type StudentField = (typeof STUDENT_FIELDS)[number];
export const PAPER_SIZES = ["A4", "F4"] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];
export const FONTS = ["times", "arial"] as const;
export type TemplateFont = (typeof FONTS)[number];
export const DEFAULT_SUBJECT = "Matematika";

export type TemplateFieldErrorKey =
  "required" | "tooLong" | "invalidCharacters" | "invalid";

// C0 and C1 control characters (and DEL), the line and paragraph separators (they would break a
// single printed line) and the bidi embedding, override and isolate controls (they can reorder
// printed text). Line breaks and tabs are allowed in the instructions only (MULTILINE_CONTROL).
const UNPRINTABLE = "\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069";
const CONTROL = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${UNPRINTABLE}]`);
const MULTILINE_CONTROL = new RegExp(
  `[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f${UNPRINTABLE}]`,
);

const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1, { message: "required" })
    .max(max, { message: "tooLong" })
    .refine((value) => !CONTROL.test(value), { message: "invalidCharacters" });

const instructionsSchema = z
  .string()
  .transform((value) => value.replace(/\r\n?/g, "\n").trim())
  .pipe(
    z
      .string()
      .max(TEMPLATE_LIMITS.instructions, { message: "tooLong" })
      .refine((value) => !MULTILINE_CONTROL.test(value), {
        message: "invalidCharacters",
      }),
  )
  .transform((value) => (value === "" ? null : value));

export const headerLineSchema = singleLine(TEMPLATE_LIMITS.headerLine);

export const templateSchema = z.object({
  name: singleLine(TEMPLATE_LIMITS.name),
  schoolName: singleLine(TEMPLATE_LIMITS.schoolName),
  headerLines: z
    .array(headerLineSchema)
    .max(TEMPLATE_LIMITS.headerLines, { message: "invalid" }),
  subject: singleLine(TEMPLATE_LIMITS.subject).default(DEFAULT_SUBJECT),
  // Kept in the canonical order, each at most once.
  studentFields: z
    .array(z.enum(STUDENT_FIELDS, { message: "invalid" }))
    .transform((fields) => STUDENT_FIELDS.filter((field) => fields.includes(field))),
  defaultInstructions: instructionsSchema.nullable().default(null),
  paperSize: z.enum(PAPER_SIZES, { message: "invalid" }).default("A4"),
  font: z.enum(FONTS, { message: "invalid" }).default("times"),
  isDefault: z.boolean().default(false),
});

export type TemplateInput = z.output<typeof templateSchema>;

/** A saved template as the Settings card shows it. */
export interface TemplateView extends TemplateInput {
  id: string;
  rowVersion: number;
  hasLogo: boolean;
  /** The stored logo is an SVG (accepted before 22 Nov): PDF and Word leave it out. */
  logoIsSvg?: boolean;
}

export const HEADER_LINE_FIELDS = [
  "headerLine0",
  "headerLine1",
  "headerLine2",
  "headerLine3",
] as const;

export type TemplateField =
  | "name"
  | "schoolName"
  | (typeof HEADER_LINE_FIELDS)[number]
  | "subject"
  | "studentFields"
  | "defaultInstructions"
  | "paperSize"
  | "font";

export type TemplateFieldErrors = Partial<Record<TemplateField, TemplateFieldErrorKey>>;

/** A form-level message (settings.templates.formErrors). */
export type TemplateFormErrorKey =
  "generic" | "unauthenticated" | "notFound" | "conflict" | "tooMany";

export interface TemplateFormState {
  error?: TemplateFormErrorKey;
  fieldErrors?: TemplateFieldErrors;
  /** When the last save succeeded, and which template it saved. */
  savedAt?: number;
  templateId?: string;
}

/** Why a logo was refused (settings.templates.logo.errors). */
export type LogoErrorKey =
  | "empty"
  | "tooLarge"
  | "unsupportedType"
  | "svgNotAccepted"
  | "invalidImage"
  | "dimensionsTooLarge"
  | "appFull"
  | "storageBusy"
  | "quota"
  | "notFound"
  | "unauthenticated"
  | "generic";

export interface LogoFormState {
  error?: LogoErrorKey;
  savedAt?: number;
}

const FIELD_KEYS: readonly TemplateFieldErrorKey[] = [
  "required",
  "tooLong",
  "invalidCharacters",
  "invalid",
];
export const asFieldKey = (message: string): TemplateFieldErrorKey =>
  (FIELD_KEYS as readonly string[]).includes(message)
    ? (message as TemplateFieldErrorKey)
    : "invalid";

/**
 * The form's values as the browser holds them: every visible field a string (the four header
 * lines by their own input names), the student fields the checked values, `isDefault` a boolean.
 */
export interface TemplateFormValues {
  name: string;
  schoolName: string;
  headerLine0: string;
  headerLine1: string;
  headerLine2: string;
  headerLine3: string;
  subject: string;
  studentFields: string[];
  defaultInstructions: string;
  paperSize: string;
  font: string;
  isDefault: boolean;
}

// A blank line is dropped; a filled one is checked like any header line, and its error stays on
// its own input.
const optionalHeaderLine = z.string().transform((value, ctx) => {
  if (value.trim() === "") return "";
  const line = headerLineSchema.safeParse(value);
  if (line.success) return line.data;
  ctx.addIssue({ code: "custom", message: line.error.issues[0]?.message ?? "invalid" });
  return z.NEVER;
});

const studentFieldsSchema = z
  .array(z.string())
  .refine((fields) => fields.every((field) => STUDENT_FIELDS.some((f) => f === field)), {
    message: "invalid",
  })
  .transform((fields) => STUDENT_FIELDS.filter((field) => fields.includes(field)));

/**
 * The template form's schema: the browser validates with it (React Hook Form) and the Server
 * Action parses the posted FormData with it (`parseTemplateForm`). Issue paths are the form's field
 * names, messages the `fieldErrors` keys.
 */
export const templateFormSchema: z.ZodType<TemplateInput, TemplateFormValues> = z
  .object({
    name: singleLine(TEMPLATE_LIMITS.name),
    schoolName: singleLine(TEMPLATE_LIMITS.schoolName),
    headerLine0: optionalHeaderLine,
    headerLine1: optionalHeaderLine,
    headerLine2: optionalHeaderLine,
    headerLine3: optionalHeaderLine,
    // A blank subject means "Matematika".
    subject: z
      .string()
      .transform((value) => (value.trim() === "" ? DEFAULT_SUBJECT : value))
      .pipe(singleLine(TEMPLATE_LIMITS.subject)),
    studentFields: studentFieldsSchema,
    defaultInstructions: instructionsSchema,
    paperSize: z.string().pipe(z.enum(PAPER_SIZES, { message: "invalid" })),
    font: z.string().pipe(z.enum(FONTS, { message: "invalid" })),
    isDefault: z.boolean(),
  })
  .transform(
    ({ headerLine0, headerLine1, headerLine2, headerLine3, ...rest }): TemplateInput => ({
      ...rest,
      headerLines: [headerLine0, headerLine1, headerLine2, headerLine3].filter(
        (line) => line !== "",
      ),
    }),
  );

/** What the browser would post, as the form's values. */
export function templateFormValues(data: FormData): TemplateFormValues {
  return {
    name: text(data, "name"),
    schoolName: text(data, "schoolName"),
    headerLine0: text(data, "headerLine0"),
    headerLine1: text(data, "headerLine1"),
    headerLine2: text(data, "headerLine2"),
    headerLine3: text(data, "headerLine3"),
    subject: text(data, "subject"),
    studentFields: texts(data, "studentFields"),
    defaultInstructions: text(data, "defaultInstructions"),
    paperSize: text(data, "paperSize"),
    font: text(data, "font"),
    isDefault: data.get("isDefault") === "on",
  };
}

const TEMPLATE_FIELDS: readonly string[] = [
  "name",
  "schoolName",
  ...HEADER_LINE_FIELDS,
  "subject",
  "studentFields",
  "defaultInstructions",
  "paperSize",
  "font",
] satisfies TemplateField[];
const isTemplateField = (value: unknown): value is TemplateField =>
  typeof value === "string" && TEMPLATE_FIELDS.includes(value);

/** The Server Action's check: the same schema as the browser, the first error key per field. */
export function parseTemplateForm(
  data: FormData,
): Result<TemplateInput, TemplateFieldErrors> {
  const parsed = templateFormSchema.safeParse(templateFormValues(data));
  if (parsed.success) return ok(parsed.data);
  const errors: TemplateFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (isTemplateField(field)) errors[field] ??= asFieldKey(issue.message);
  }
  return err(Object.keys(errors).length > 0 ? errors : { name: "invalid" });
}
