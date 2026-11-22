// The e2e fake AI against the solver's real prompts (plan 5, Task 9): every solver call lands on
// its own scripted task, and the scripted answers pass the same schemas and checks as a real
// model's (an uncertain photo reading, a solution verified automatically).
import { afterEach, describe, expect, it } from "vitest";
import { defaultRouting } from "@/lib/ai/routing.config";
import { getE2eAiState, resetE2eAi } from "@/lib/ai/e2e/control";
import {
  E2E_ALTERNATIVE_METHOD,
  E2E_METHOD,
  E2E_PHOTO_MARKDOWN,
} from "@/lib/ai/e2e/material-scripts";
import { createScriptedProvider } from "@/lib/ai/e2e/scripted-provider";
import { extractionAnswerSchema, solutionAnswerSchema } from "../schema/answers";
import { extractionFlags } from "./issues";
import { buildCrossCheckPrompt } from "./prompts/cross-check.id";
import { buildExtractProblemPrompt } from "./prompts/extract-problem.id";
import { buildSolvePrompt } from "./prompts/solve-problem.id";
import { crossCheckAgreement, verifySolution } from "./verify-solution";

afterEach(() => {
  resetE2eAi();
});

const PROBLEM = "Hitung $17 + 25$.";
const VISION = defaultRouting.ocr_page[0].model;
const SOLVE = defaultRouting.solve_problem[0].model;
const CROSS = defaultRouting.solve_independent[0].model;

async function call(model: string, built: { system: string; prompt: string }) {
  const completion = await createScriptedProvider("groq").complete(
    model,
    built.system,
    built.prompt,
  );
  return JSON.parse(completion.text) as unknown;
}

describe("the e2e scripted provider and the solver prompts", () => {
  it("reads a photo with an uncertain part, which forces the confirmation", async () => {
    const reading = extractionAnswerSchema.parse(
      await call(VISION, buildExtractProblemPrompt()),
    );
    expect(reading.markdown).toBe(E2E_PHOTO_MARKDOWN);
    expect(extractionFlags(reading.markdown, { truncated: false })).toContain(
      "uncertain",
    );
    expect(getE2eAiState().calls.extract_problem).toBe(1);
  });

  it("solves the problem and the independent cross-check agrees: verified automatically", async () => {
    const solution = solutionAnswerSchema.parse(
      await call(SOLVE, buildSolvePrompt({ problemMd: PROBLEM })),
    );
    expect(solution.method).toBe(E2E_METHOD);
    const cross = (await call(CROSS, buildCrossCheckPrompt(PROBLEM))) as {
      answer: string;
    };
    const crossCheck = crossCheckAgreement(solution.final_answer.value, cross.answer);
    expect(crossCheck).toBe("agree");
    expect(verifySolution(solution, { problemMd: PROBLEM, crossCheck }).status).toBe(
      "terverifikasi",
    );
    expect(getE2eAiState().calls).toMatchObject({
      solve_problem: 1,
      solve_cross_check: 1,
      generate: 0,
      solver: 0,
    });
  });

  it("answers 'show another method' with a different method", async () => {
    const other = solutionAnswerSchema.parse(
      await call(
        SOLVE,
        buildSolvePrompt({ problemMd: PROBLEM, excludeMethods: [E2E_METHOD] }),
      ),
    );
    expect(other.method).toBe(E2E_ALTERNATIVE_METHOD);
    expect(other.final_answer.value).toBe("42");
    expect(getE2eAiState().calls.alternative_method).toBe(1);
  });
});
