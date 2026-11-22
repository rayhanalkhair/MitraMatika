import { z } from "zod";

// The shape createGenerationRequest writes into generation_requests.params. The handler re-validates
// it because the row could have been written by an older version or by hand.
export const generationParamsSchema = z.object({
  grade: z.literal(8),
  topicId: z.guid(),
  topicStableKey: z.string().min(1),
  topicTitle: z.string().min(1),
  curriculumVersionId: z.guid(),
  type: z.literal("multiple_choice"),
  quantity: z.number().int().min(1).max(5),
  difficulty: z.enum(["mudah", "sedang", "sulit"]),
});

export type GenerationParams = z.infer<typeof generationParamsSchema>;
