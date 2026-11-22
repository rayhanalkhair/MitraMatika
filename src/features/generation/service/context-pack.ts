import type { TopicDetail } from "@/features/curriculum";
import type { GenerateMcParams } from "./prompts/generate-mc.id";
import type { GenerationParams } from "./request-params";

// The prompt input for one request: the topic's title, scope notes and TP. The data class is C0
// because the prompt holds curriculum text only (no teacher material, no student data).
export function buildContextPack(
  topic: TopicDetail,
  params: Pick<GenerationParams, "difficulty" | "quantity">,
): GenerateMcParams {
  return {
    grade: 8,
    topicTitle: topic.title,
    topicScopeNotes: topic.scopeNotes,
    objectives: topic.objectives.map((objective) => ({
      code: objective.code,
      text: objective.text,
    })),
    difficulty: params.difficulty,
    count: params.quantity,
    dataClass: "C0",
  };
}
