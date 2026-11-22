import { DIFFICULTIES } from "../schema/request-input";

export interface RequestSummary {
  topicTitle: string;
  quantity: number;
  difficulty: (typeof DIFFICULTIES)[number];
}

// Reads the display fields out of the stored request params, defensively: the params are jsonb.
export function parseRequestSummary(params: unknown): RequestSummary | null {
  if (typeof params !== "object" || params === null) return null;
  const record = params as Record<string, unknown>;
  const { topicTitle, quantity, difficulty } = record;
  if (typeof topicTitle !== "string" || topicTitle === "") return null;
  if (
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 5
  ) {
    return null;
  }
  if (!DIFFICULTIES.includes(difficulty as RequestSummary["difficulty"])) return null;
  return { topicTitle, quantity, difficulty: difficulty as RequestSummary["difficulty"] };
}
