import { z } from "zod";

// The same limits as LENGTH_LIMITS in the generation structural checks (a test keeps them equal).
// Written out here because this file is shared with the editor, a client component, and the
// generation index pulls in the database schema.
export const EDIT_LIMITS = {
  stem: 1_200,
  option: 300,
  explanation: 2_000,
  step: 500,
  maxSteps: 12,
} as const;

export type OptionLabel = "A" | "B" | "C" | "D";

/** What the teacher can change on a question. The machine answer and the claims are never typed. */
export interface EditInput {
  stemMd: string;
  options: { label: OptionLabel; textMd: string }[];
  correctLabel: OptionLabel;
  answerDisplayMd: string;
  explanationMd: string;
  steps: string[];
}

const label = z.enum(["A", "B", "C", "D"]);
const text = (max: number) => z.string().trim().min(1).max(max);

// The text fields both schemas share.
const fields = {
  stemMd: text(EDIT_LIMITS.stem),
  options: z
    .array(z.object({ label, textMd: text(EDIT_LIMITS.option) }))
    .length(4)
    // Always A, B, C, D in that order: the form sends them so, a crafted request may not reorder.
    .refine((options) => options.every((option, i) => option.label === "ABCD"[i])),
  correctLabel: label,
  answerDisplayMd: text(EDIT_LIMITS.option),
  explanationMd: text(EDIT_LIMITS.explanation),
};

/** What the service stores: the steps are plain strings. */
export const editInputSchema = z.object({
  ...fields,
  // Blank steps are dropped before the limits are checked.
  steps: z
    // Blank lines count here, so the cap is generous but bounded.
    .array(z.string())
    .max(EDIT_LIMITS.maxSteps * 4)
    .transform((steps) => steps.map((step) => step.trim()).filter((step) => step !== ""))
    .pipe(z.array(z.string().max(EDIT_LIMITS.step)).max(EDIT_LIMITS.maxSteps)),
});

/**
 * What the editor form holds: the same fields with the steps as rows (`{ textMd }`, so each row
 * is a field of its own). It parses to an EditInput by the same rules (a step's own length is
 * checked on the row, before blank rows are dropped, so its path is the row's `steps.1.textMd`).
 * The form and the Server Action both parse with it.
 */
export const editFormSchema = z.object({
  ...fields,
  steps: z
    .array(z.object({ textMd: z.string().trim().max(EDIT_LIMITS.step) }))
    .max(EDIT_LIMITS.maxSteps * 4)
    .transform((rows) => rows.map((row) => row.textMd).filter((step) => step !== ""))
    .pipe(z.array(z.string()).max(EDIT_LIMITS.maxSteps)),
});

/** The values of the editor form (what it holds before it is parsed). */
export type EditFormValues = z.input<typeof editFormSchema>;

export type ParsedEditInput =
  { ok: true; value: EditInput } | { ok: false; fields: string[] };

/** Field paths of what is wrong, e.g. "stemMd" or "options.2.textMd"; empty when not an object. */
export function parseEditInput(raw: unknown): ParsedEditInput {
  const parsed = editInputSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const fields = new Set<string>();
  for (const issue of parsed.error.issues) {
    if (issue.path.length > 0) fields.add(issue.path.join("."));
  }
  return { ok: false, fields: [...fields] };
}
