import { z } from "zod";
import { normalizeAiText } from "@/lib/normalize-ai-text";

export const claimSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("numeric_eval"),
    expression: z.string().min(1),
    expected: z.string().min(1),
  }),
  z.object({
    type: z.literal("expression_equivalent"),
    a: z.string().min(1),
    b: z.string().min(1),
    variables: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal("equation_solution"),
    equation: z.string().min(1),
    variable: z.string().min(1),
    solutions: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal("choice_matches_answer"),
    options: z.array(z.string().min(1)).min(1),
    markedIndex: z.number().int().nonnegative(),
    answer: z.string().min(1),
  }),
]);

const optionLabel = z.enum(["A", "B", "C", "D"]);

/** Displayed Markdown: a literal backslash-n the model wrote between formulas becomes a real line break. */
const markdown = () => z.string().min(1).transform(normalizeAiText);

const optionsSchema = z
  .array(z.object({ label: optionLabel, text_md: markdown() }))
  .length(4)
  .refine((options) => new Set(options.map((o) => o.label)).size === 4, {
    message: "Setiap label pilihan (A-D) harus muncul tepat satu kali.",
  });

export const multipleChoiceQuestionSchema = z.object({
  stem_md: markdown(),
  options: optionsSchema,
  correctLabel: optionLabel,
  answer: z.object({
    display_md: markdown(),
    machine: z.string().min(1),
  }),
  explanation_md: markdown(),
  steps: z.array(markdown()).min(2),
  verification_claims: z.array(claimSchema).min(1),
  metadata: z.object({
    difficulty: z.enum(["mudah", "sedang", "sulit"]),
    estimatedMinutes: z.number().positive().optional(),
    tags: z.array(z.string().min(1)).optional(),
  }),
  // Material mode only: the passage ids the question is based on. Never refused here (one bad
  // entry would fail the whole batch); validateCitations judges them per question, and an entry
  // that is not a string becomes "" so it cannot pass.
  citations: z
    .array(z.unknown())
    .transform((list) =>
      list
        .slice(0, 20)
        .map((entry) => (typeof entry === "string" ? entry.slice(0, 40) : "")),
    )
    .optional(),
});

export const multipleChoiceBatchSchema = z.object({
  questions: z.array(multipleChoiceQuestionSchema).min(1).max(10),
});

export type Claim = z.infer<typeof claimSchema>;
export type MultipleChoiceQuestion = z.infer<typeof multipleChoiceQuestionSchema>;
export type MultipleChoiceBatch = z.infer<typeof multipleChoiceBatchSchema>;
