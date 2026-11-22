import { z } from "zod";
import { text, texts } from "@/lib/forms/form-data";
import type {
  GenerationErrorKey,
  GenerationFieldErrors,
  GenerationFieldName,
} from "./form-state";
import {
  MATERIAL_SCOPES,
  materialSelectionSchema,
  parsePageList,
  type MaterialSelection,
} from "./material-selection";

export const DIFFICULTIES = ["mudah", "sedang", "sulit"] as const;
export const GENERATION_SOURCES = ["topic", "material"] as const;

export interface GenerationInput {
  topic: string;
  count: number;
  difficulty: (typeof DIFFICULTIES)[number];
  // Present only when the teacher chose "Dari materi".
  material?: MaterialSelection;
}

export type ParsedGenerationInput =
  { ok: true; value: GenerationInput } | { ok: false; errors: GenerationFieldErrors };

// The values are message keys in the catalog (errors.*), which keep their Indonesian names. A field
// whose issue carries no key of its own (a value of the wrong type) falls back to these.
export const DEFAULT_ERROR_KEYS: Record<GenerationFieldName, GenerationErrorKey> = {
  grade: "kelas",
  topic: "topik",
  count: "jumlah",
  difficulty: "kesulitan",
  material: "materialMissing",
};

type MaterialErrorKey = "materialMissing" | "sectionsMissing" | "pagesInvalid";
const SCHEMA_ERROR_KEYS = new Set<string>([
  ...Object.values(DEFAULT_ERROR_KEYS),
  "sectionsMissing",
  "pagesInvalid",
] satisfies GenerationErrorKey[]);

interface MaterialFields {
  materialId: string;
  materialScope: string;
  sectionIds: readonly string[];
  pages: string;
}

type ParsedMaterial =
  { ok: true; value: MaterialSelection } | { ok: false; error: MaterialErrorKey };

// The "Dari materi" fields: a material, then the whole document, chapters or a page list.
function materialSelectionOf(fields: MaterialFields): ParsedMaterial {
  const materialId = fields.materialId.trim();
  const scope = fields.materialScope;
  let candidate: unknown;
  if (scope === "sections") {
    if (fields.sectionIds.length === 0) return { ok: false, error: "sectionsMissing" };
    candidate = { materialId, scope, sectionIds: fields.sectionIds };
  } else if (scope === "pages") {
    const pages = parsePageList(fields.pages);
    if (!pages) return { ok: false, error: "pagesInvalid" };
    candidate = { materialId, scope, pages };
  } else {
    candidate = { materialId, scope: "all" };
  }
  const parsed = materialSelectionSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, value: parsed.data };
  // An id that is not a material id reads as no material chosen; a list past the limits as a
  // bad page list or chapter choice.
  const field = parsed.error.issues[0]?.path[0];
  if (field === "pages") return { ok: false, error: "pagesInvalid" };
  if (field === "sectionIds") return { ok: false, error: "sectionsMissing" };
  return { ok: false, error: "materialMissing" };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringOr = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

/**
 * The generation form (decision 5 of the stack-alignment plan): the raw form values in (strings,
 * the chapter checkboxes as a list), the service input out. React Hook Form's resolver validates
 * with it in the browser; the Server Action parses the posted FormData with it again
 * (`parseGenerationInput`). Issue messages are `generate.errors` keys. The material fields are
 * checked only when the source is "Dari materi", and their one error sits on the path `material`.
 */
export const generationFormSchema = z
  .object({
    // A hidden field: the only grade offered.
    grade: z.string().refine((grade) => grade === "8", { message: "kelas" }),
    topic: z
      .string({ message: "topik" })
      .trim()
      .min(1, { message: "topik" })
      .max(100, { message: "topik" }),
    count: z
      .string({ message: "jumlah" })
      .pipe(
        z.coerce
          .number<string>({ message: "jumlah" })
          .int({ message: "jumlah" })
          .min(1, { message: "jumlah" })
          .max(5, { message: "jumlah" }),
      ),
    difficulty: z
      .string({ message: "kesulitan" })
      .pipe(z.enum(DIFFICULTIES, { message: "kesulitan" })),
    source: z.enum(GENERATION_SOURCES),
    materialId: z.string(),
    materialScope: z.enum(MATERIAL_SCOPES),
    sectionIds: z.array(z.string()),
    pages: z.string(),
  })
  .superRefine(
    (values, ctx) => {
      if (values.source !== "material") return;
      const material = materialSelectionOf(values);
      if (!material.ok) {
        ctx.addIssue({ code: "custom", path: ["material"], message: material.error });
      }
    },
    {
      // Also next to the other fields' errors (all of them show at once), as long as the material
      // fields themselves are readable.
      when: ({ value }) =>
        isRecord(value) &&
        value.source === "material" &&
        typeof value.materialId === "string" &&
        typeof value.materialScope === "string" &&
        Array.isArray(value.sectionIds) &&
        typeof value.pages === "string",
    },
  )
  .transform((values, ctx): GenerationInput => {
    const { topic, count, difficulty } = values;
    if (values.source !== "material") return { topic, count, difficulty };
    const material = materialSelectionOf(values);
    if (!material.ok) {
      // Unreachable: the refinement above reported it already.
      ctx.addIssue({ code: "custom", path: ["material"], message: material.error });
      return z.NEVER;
    }
    return { topic, count, difficulty, material: material.value };
  });

/** What the form holds: every value as the browser posts it. */
export type GenerationFormValues = z.input<typeof generationFormSchema>;

/** The form's starting values; the topic comes from the URL. */
export function generationFormDefaults(topic: string | null): GenerationFormValues {
  return {
    grade: "8",
    topic: topic ?? "",
    count: "5",
    difficulty: "sedang",
    source: "topic",
    materialId: "",
    materialScope: "all",
    sectionIds: [],
    pages: "",
  };
}

/**
 * The posted FormData as the schema's raw values. A missing count or difficulty is the form's
 * default; any source other than "material" is the topic, and an unknown scope the whole document.
 */
export function generationFormValues(data: FormData): GenerationFormValues {
  const scope = text(data, "materialScope");
  return {
    grade: text(data, "grade"),
    topic: text(data, "topic"),
    count: stringOr(data.get("count"), "5"),
    difficulty: stringOr(data.get("difficulty"), "sedang"),
    source: text(data, "source") === "material" ? "material" : "topic",
    materialId: text(data, "materialId"),
    materialScope: scope === "sections" || scope === "pages" ? scope : "all",
    sectionIds: texts(data, "sectionIds"),
    pages: text(data, "pages"),
  };
}

const isFieldName = (value: unknown): value is GenerationFieldName =>
  typeof value === "string" && Object.hasOwn(DEFAULT_ERROR_KEYS, value);

/** The Server Action's check: the same schema as the browser, one error key per field. */
export function parseGenerationInput(formData: FormData): ParsedGenerationInput {
  const result = generationFormSchema.safeParse(generationFormValues(formData));
  if (result.success) return { ok: true, value: result.data };
  const errors: GenerationFieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (!isFieldName(field) || errors[field] !== undefined) continue;
    errors[field] = SCHEMA_ERROR_KEYS.has(issue.message)
      ? (issue.message as GenerationErrorKey)
      : DEFAULT_ERROR_KEYS[field];
  }
  return { ok: false, errors };
}
