import { batchJson, questionJson, solverJson } from "@/features/generation";
import { AiProviderError } from "../types";
import type { E2eMaterialTask, Scenario } from "./control";
import {
  crossCheckAnswer,
  extractAnswer,
  ocrAnswer,
  solutionAnswer,
  structureAnswer,
  withCitations,
} from "./material-scripts";

// The kinds of model call the generation pipeline makes (told apart in scripted-provider.ts):
// the batch (and its repair retry), the solver, and the one-question regeneration of a
// contradicted draft; then the calls of the materials and the problem solver.
export type E2eTask = "generate" | "regenerate" | "solver" | E2eMaterialTask;

// What the scripted provider read from the request. `count` is the number of questions the
// generate prompt asked for; `n` identifies the question being solved (see questionJson); `label`
// is the letter of the option holding that question's answer in the solver prompt (the saved
// options are shuffled, so it is not always B).
export interface AnswerContext {
  count?: number;
  n?: number;
  label?: "A" | "B" | "C" | "D";
  // Material mode: the passage ids the generate prompt allows ("Gunakan HANYA id berikut").
  passageIds?: string[];
  // The solver: the two numbers of the problem's `a + b`.
  addends?: [number, number];
  // The structure proposal: the material's page count and the key of the SPLDV topic, if listed.
  pageCount?: number;
  topicKey?: string | null;
}

export const E2E_RATE_LIMIT_MESSAGE = "Layanan AI sedang membatasi permintaan.";

// questionJson(n) with a claim that cannot hold: the version is contradicted whatever the solver
// says, and the regeneration is scripted to be just as wrong.
function contradicted(n: number) {
  return {
    ...questionJson(n),
    verification_claims: [
      { type: "numeric_eval", expression: `${String(n)}+${String(n)}`, expected: "99" },
    ],
  };
}

function noAnswer(scenario: Scenario, task: E2eTask, callIndex: number): Error {
  return new Error(
    `e2e scripted AI: scenario=${scenario} task=${task} call=${String(callIndex)} has no scripted answer`,
  );
}

// The text a provider returns for the callIndex-th call (from 0, per task, since the last
// reset) of `task` in `scenario`, or the Error it throws. Never undefined: a call nobody
// scripted is an Error that names the scenario, task and index (the caller throws it).
export function answerFor(
  scenario: Scenario,
  task: E2eTask,
  callIndex: number,
  context: AnswerContext = {},
): string | Error {
  const missing = noAnswer(scenario, task, callIndex);

  // The materials and solver calls answer the same in every scenario.
  switch (task) {
    case "ocr_page":
      return ocrAnswer();
    case "extract_problem":
      return extractAnswer();
    case "propose_structure":
      return context.pageCount === undefined
        ? missing
        : structureAnswer(context.pageCount, context.topicKey ?? null);
    case "solve_problem":
    case "alternative_method":
      return context.addends === undefined
        ? missing
        : solutionAnswer(context.addends, task === "alternative_method");
    case "solve_cross_check":
      return context.addends === undefined ? missing : crossCheckAnswer(context.addends);
    default:
      break;
  }

  // Material mode: every question cites the prompt's passages (the scenario may invent one).
  const cite = (batch: string) =>
    context.passageIds && context.passageIds.length > 0
      ? withCitations(batch, context.passageIds, scenario === "invented_citation")
      : batch;
  const answer = topicAnswer(scenario, task, callIndex, context, missing);
  return task !== "solver" && typeof answer === "string" && answer.startsWith("{")
    ? cite(answer)
    : answer;
}

function topicAnswer(
  scenario: Scenario,
  task: E2eTask,
  callIndex: number,
  context: AnswerContext,
  missing: Error,
): string | Error {
  if (task === "solver") {
    if (context.n === undefined) return missing;
    // Agrees with the marked key and value of question n (B when the prompt shows no options).
    return JSON.stringify(solverJson(context.label ?? "B", String(2 * context.n)));
  }

  if (task === "regenerate") {
    if (scenario === "wrong_key_persistent") {
      return JSON.stringify({ questions: [contradicted(1)] });
    }
    return batchJson(1);
  }

  const count = context.count;
  if (count === undefined) return missing;
  switch (scenario) {
    case "valid":
    case "invented_citation":
      return batchJson(count);
    case "malformed_repairable":
      // Call 0 is rejected, the repair (call 1) and any later call (a retried job) succeed.
      return callIndex === 0 ? "not json" : batchJson(count);
    case "malformed_twice":
      // Every call is rejected: the job is retried by the queue (max_attempts 3), and each
      // attempt must end as invalid_output, so there is no index at which this recovers.
      return "not json";
    case "wrong_key_persistent": {
      // Steady state for every call: question 1 stays contradicted.
      const questions = (JSON.parse(batchJson(count)) as { questions: unknown[] })
        .questions;
      questions[0] = contradicted(1);
      return JSON.stringify({ questions });
    }
    case "rate_limited":
      if (callIndex === 0) {
        return new AiProviderError("rate_limited", E2E_RATE_LIMIT_MESSAGE, {
          status: 429,
          retryAfterMs: 60_000,
        });
      }
      return batchJson(count);
  }
}
