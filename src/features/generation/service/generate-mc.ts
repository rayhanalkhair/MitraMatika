import type { AiUsage, createGateway } from "@/lib/ai";
import { findInvalidMathSpans } from "./katex-check";
import { buildGenerateMcPrompt, type GenerateMcParams } from "./prompts/generate-mc.id";
import { multipleChoiceBatchSchema, type MultipleChoiceBatch } from "../schema/schemas";

export type { GenerateMcParams } from "./prompts/generate-mc.id";

function collectMathFields(batch: MultipleChoiceBatch): string[] {
  const fields: string[] = [];
  for (const question of batch.questions) {
    fields.push(question.stem_md, question.explanation_md, question.answer.display_md);
    for (const option of question.options) fields.push(option.text_md);
    for (const step of question.steps) fields.push(step);
  }
  return fields;
}

export interface GenerateMcOptions {
  maxOutputTokens?: number;
  onUsage?: (usage: AiUsage) => void;
}

// The batch shape plus parseable math in every displayed field; the gateway repairs once on a throw.
export function parseMultipleChoiceBatch(raw: unknown): MultipleChoiceBatch {
  const batch = multipleChoiceBatchSchema.parse(raw);
  const invalidSpans = collectMathFields(batch).flatMap((text) =>
    findInvalidMathSpans(text),
  );
  if (invalidSpans.length > 0) {
    throw new Error(
      `Ditemukan notasi matematika yang tidak valid: ${invalidSpans.join(", ")}`,
    );
  }
  return batch;
}

export async function generateMultipleChoiceBatch(
  gateway: ReturnType<typeof createGateway>,
  params: GenerateMcParams,
  options: GenerateMcOptions = {},
) {
  const { system, prompt } = buildGenerateMcPrompt(params);

  return gateway.generate({
    task: "generate_questions",
    dataClass: params.dataClass,
    system,
    prompt,
    maxOutputTokens: options.maxOutputTokens,
    onUsage: options.onUsage,
    parse: parseMultipleChoiceBatch,
  });
}
