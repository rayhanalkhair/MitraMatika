import { z } from "zod";
import type { AiUsage, createGateway } from "@/lib/ai";
import { findInvalidMathSpans } from "./katex-check";
import {
  buildSolveIndependentPrompt,
  type SolveIndependentParams,
} from "./prompts/solve-independent.id";

export type { SolveIndependentParams } from "./prompts/solve-independent.id";

const solveIndependentResultSchema = z.object({
  correctLabel: z.enum(["A", "B", "C", "D"]),
  answer: z.object({
    display_md: z.string().min(1),
    machine: z.string().min(1),
  }),
  steps: z.array(z.string().min(1)).min(1),
});

export type SolveIndependentResult = z.infer<typeof solveIndependentResultSchema>;

export interface SolveIndependentOptions {
  maxOutputTokens?: number;
  onUsage?: (usage: AiUsage) => void;
}

export async function solveIndependent(
  gateway: ReturnType<typeof createGateway>,
  params: SolveIndependentParams,
  options: SolveIndependentOptions = {},
) {
  const { system, prompt } = buildSolveIndependentPrompt(params);

  return gateway.generate({
    task: "solve_independent",
    dataClass: params.dataClass,
    system,
    prompt,
    maxOutputTokens: options.maxOutputTokens,
    onUsage: options.onUsage,
    parse: (raw: unknown): SolveIndependentResult => {
      const result = solveIndependentResultSchema.parse(raw);
      const invalidSpans = [
        ...findInvalidMathSpans(result.answer.display_md),
        ...result.steps.flatMap((step) => findInvalidMathSpans(step)),
      ];
      if (invalidSpans.length > 0) {
        throw new Error(
          `Ditemukan notasi matematika yang tidak valid: ${invalidSpans.join(", ")}`,
        );
      }
      return result;
    },
  });
}
