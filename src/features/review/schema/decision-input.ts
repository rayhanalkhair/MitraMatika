import { z } from "zod";
import type { DecisionAction } from "../service/decision";

// The note limit here is a coarse bound before trimming; decideQuestion enforces 10 to 500.
const decisionInputSchema = z.object({
  questionId: z.uuid(),
  versionId: z.uuid(),
  rowVersion: z.number().int().min(1),
  action: z.enum(["approve", "reject", "reset"]),
  overrideNote: z.string().max(2000).optional(),
});

export interface DecisionInput {
  questionId: string;
  versionId: string;
  rowVersion: number;
  action: DecisionAction;
  overrideNote?: string;
}

export function parseDecisionInput(
  raw: unknown,
): { ok: true; value: DecisionInput } | { ok: false } {
  const parsed = decisionInputSchema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}
