import { z } from "zod";

// The job type that regenerates one question; also counted toward the per-user daily limit.
export const REGENERATE_JOB_TYPE = "regenerate_question";

// How long a teacher's free-text hint may be. Longer text is cut, never rejected: the hint is a
// nudge for the model, and the form already stops typing at this length.
export const HINT_TEXT_MAX = 200;

export const regenerateHintSchema = z
  .union([
    z.enum(["easier", "harder", "otherContext"]),
    z.object({ text: z.string().max(2_000) }).strict(),
  ])
  .nullable();

export type RegenerateHint = z.infer<typeof regenerateHintSchema>;

export const regeneratePayloadSchema = z
  .object({ questionId: z.guid(), hint: regenerateHintSchema })
  .strict();

export type RegeneratePayload = z.infer<typeof regeneratePayloadSchema>;
