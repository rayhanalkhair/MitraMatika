// What the models return to the solver. Nothing a model returns is executed: the steps are stored
// as Markdown text and the claims are checked by the deterministic verifier.
import { z } from "zod";
import { claimSchema } from "@/features/generation";
import { MAX_METHOD_LABEL_CHARS, MAX_STEPS } from "./solver";

/** The vision model's answer: the problem as Markdown with `[[?]]` around unsure parts (R14). */
export const extractionAnswerSchema = z.object({
  markdown: z.string().max(50_000),
});
export type ExtractionAnswer = z.infer<typeof extractionAnswerSchema>;

const shortText = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(max));

/**
 * The text model's solution. Unknown keys are dropped; claims of a kind the verifier does not know
 * are dropped (not refused), so they can never count as a check.
 */
export const solutionAnswerSchema = z.object({
  method: shortText(MAX_METHOD_LABEL_CHARS),
  steps: z
    .array(
      z.object({
        title: z.string().max(200).optional(),
        body_md: shortText(4_000),
      }),
    )
    .min(1)
    .max(MAX_STEPS),
  final_answer: z.object({
    value: shortText(200),
    unit: z.string().max(40).nullish(),
    rounding: z.string().max(120).nullish(),
  }),
  verification_claims: z
    .array(z.unknown())
    .max(20)
    .default([])
    .transform((list) =>
      list.flatMap((entry) => {
        const claim = claimSchema.safeParse(entry);
        return claim.success && claim.data.type !== "choice_matches_answer"
          ? [claim.data]
          : [];
      }),
    ),
});
export type SolutionAnswer = z.infer<typeof solutionAnswerSchema>;
