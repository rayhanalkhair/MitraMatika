import type { createGateway } from "@/lib/ai/gateway";
import type { AiCallLogger, AiCallRecord } from "@/lib/ai/logging";
import { generateMultipleChoiceBatch, solveIndependent } from "@/features/generation";
import type { MultipleChoiceQuestion } from "@/features/generation";
import { verifyClaims } from "@/features/verification";
import { plantError } from "./planted-errors";
import type {
  GoldenGenerationSpec,
  GoldenSolverProblem,
} from "../schema/golden-set-schema";

export class InMemoryAiCallLog implements AiCallLogger {
  readonly entries: AiCallRecord[] = [];

  record(entry: AiCallRecord): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

export interface GenerationItemResult {
  specId: string;
  ok: boolean;
  schemaValid: boolean;
  question?: MultipleChoiceQuestion;
  keyAccuracyVerified?: boolean;
  plantedErrorCaught?: boolean;
  plantedErrorCheckError?: string;
  crossCheckAgreed?: boolean;
  crossCheckError?: string;
  tokensPrompt?: number;
  tokensCompletion?: number;
  latencyMs?: number;
  error?: string;
}

function sumCallWindow(
  callLog: AiCallRecord[],
  from: number,
): { promptTokens: number; completionTokens: number; latencyMs: number } {
  const slice = callLog.slice(from);
  return {
    promptTokens: slice.reduce((sum, c) => sum + (c.promptTokens ?? 0), 0),
    completionTokens: slice.reduce((sum, c) => sum + (c.completionTokens ?? 0), 0),
    latencyMs: slice.reduce((sum, c) => sum + c.latencyMs, 0),
  };
}

function optionTextByLabel(
  options: { label: "A" | "B" | "C" | "D"; text_md: string }[],
  label: "A" | "B" | "C" | "D",
): string {
  const found = options.find((o) => o.label === label);
  if (!found) throw new Error(`Pilihan berlabel ${label} tidak ditemukan.`);
  return found.text_md;
}

export async function scoreGenerationSpec(
  gateway: ReturnType<typeof createGateway>,
  spec: GoldenGenerationSpec,
  topicScopeNotes: Map<string, string>,
  callLog: AiCallRecord[],
): Promise<GenerationItemResult> {
  const scopeNotes = topicScopeNotes.get(spec.topicStableKey);
  if (scopeNotes === undefined) {
    return {
      specId: spec.id,
      ok: false,
      schemaValid: false,
      error: `Tidak ditemukan cakupan topik untuk ${spec.topicStableKey}.`,
    };
  }

  const before = callLog.length;
  let question: MultipleChoiceQuestion;
  try {
    const generated = await generateMultipleChoiceBatch(gateway, {
      grade: spec.grade,
      topicTitle: spec.topicTitle,
      topicScopeNotes: scopeNotes,
      difficulty: spec.difficulty,
      count: spec.count,
      dataClass: "C0",
    });
    question = generated.value.questions[0];
  } catch (error) {
    const totals = sumCallWindow(callLog, before);
    return {
      specId: spec.id,
      ok: false,
      schemaValid: false,
      tokensPrompt: totals.promptTokens,
      tokensCompletion: totals.completionTokens,
      latencyMs: totals.latencyMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const verification = verifyClaims(question.verification_claims);
  const keyAccuracyVerified = verification.status === "terverifikasi";

  // A planted-error check failure (no corruption offset makes the claim fail,
  // or evaluateClaim itself throws for a claim shape it can't handle) must not
  // discard a generation that already succeeded — same reasoning as the
  // cross-check try/catch below. Leaves plantedErrorCaught unset, which
  // runEval's plantedEligible filter already excludes.
  let plantedErrorCaught: boolean | undefined;
  let plantedErrorCheckError: string | undefined;
  if (keyAccuracyVerified) {
    try {
      const mutated = plantError(question);
      const mutatedVerification = verifyClaims(mutated.verification_claims);
      plantedErrorCaught = mutatedVerification.status === "ketidaksesuaian";
    } catch (error) {
      plantedErrorCheckError = error instanceof Error ? error.message : String(error);
    }
  }

  // A cross-check failure (quota, its own schema failure, ...) must not discard
  // a generation that already succeeded — it only leaves crossCheckAgreed unset,
  // which runEval's crossCheckEligible filter already excludes.
  let crossCheckAgreed: boolean | undefined;
  let crossCheckError: string | undefined;
  try {
    const solved = await solveIndependent(gateway, {
      questionStemMd: question.stem_md,
      optionTexts_md: [
        optionTextByLabel(question.options, "A"),
        optionTextByLabel(question.options, "B"),
        optionTextByLabel(question.options, "C"),
        optionTextByLabel(question.options, "D"),
      ],
      dataClass: "C0",
    });
    crossCheckAgreed = solved.value.correctLabel === question.correctLabel;
  } catch (error) {
    crossCheckError = error instanceof Error ? error.message : String(error);
  }

  const totals = sumCallWindow(callLog, before);
  return {
    specId: spec.id,
    ok: true,
    schemaValid: true,
    question,
    keyAccuracyVerified,
    plantedErrorCaught,
    plantedErrorCheckError,
    crossCheckAgreed,
    crossCheckError,
    tokensPrompt: totals.promptTokens,
    tokensCompletion: totals.completionTokens,
    latencyMs: totals.latencyMs,
  };
}

export interface SolverItemResult {
  problemId: string;
  ok: boolean;
  correct: boolean;
  tokensPrompt?: number;
  tokensCompletion?: number;
  latencyMs?: number;
  error?: string;
}

export async function scoreSolverProblem(
  gateway: ReturnType<typeof createGateway>,
  problem: GoldenSolverProblem,
  callLog: AiCallRecord[],
): Promise<SolverItemResult> {
  const before = callLog.length;
  try {
    const solved = await solveIndependent(gateway, {
      questionStemMd: problem.stem_md,
      optionTexts_md: [
        optionTextByLabel(problem.options, "A"),
        optionTextByLabel(problem.options, "B"),
        optionTextByLabel(problem.options, "C"),
        optionTextByLabel(problem.options, "D"),
      ],
      dataClass: "C0",
    });
    const totals = sumCallWindow(callLog, before);
    return {
      problemId: problem.id,
      ok: true,
      correct: solved.value.correctLabel === problem.correctLabel,
      tokensPrompt: totals.promptTokens,
      tokensCompletion: totals.completionTokens,
      latencyMs: totals.latencyMs,
    };
  } catch (error) {
    const totals = sumCallWindow(callLog, before);
    return {
      problemId: problem.id,
      ok: false,
      correct: false,
      tokensPrompt: totals.promptTokens,
      tokensCompletion: totals.completionTokens,
      latencyMs: totals.latencyMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface EvalReport {
  generatedAt: string;
  provider: "fake" | "real";
  thresholds: { correctKeys: number; plantedErrorsCaught: number; schemaValid: number };
  generation: GenerationItemResult[];
  solver: SolverItemResult[];
  summary: {
    schemaValidRate: number;
    keyAccuracyRate: number;
    plantedErrorCatchRate: number;
    crossCheckAgreementRate: number;
    solverAccuracyRate: number;
    totalTokens: number;
    avgLatencyMs: number;
  };
}

export interface RunEvalOptions {
  provider: "fake" | "real";
  now?: () => string;
  // Pause after each golden-set item (generation and solver) so real-provider
  // runs stay under the per-minute token budget. Omitted means no pause.
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

export async function runEval(
  gateway: ReturnType<typeof createGateway>,
  generationSpecs: GoldenGenerationSpec[],
  solverProblems: GoldenSolverProblem[],
  topicScopeNotes: Map<string, string>,
  callLog: AiCallRecord[],
  options: RunEvalOptions,
): Promise<EvalReport> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const generation: GenerationItemResult[] = [];
  for (const spec of generationSpecs) {
    generation.push(await scoreGenerationSpec(gateway, spec, topicScopeNotes, callLog));
    if (options.delayMs) await sleep(options.delayMs);
  }

  const solver: SolverItemResult[] = [];
  for (const problem of solverProblems) {
    solver.push(await scoreSolverProblem(gateway, problem, callLog));
    if (options.delayMs) await sleep(options.delayMs);
  }

  const schemaValidCount = generation.filter((g) => g.schemaValid).length;
  const keyAccurateCount = generation.filter((g) => g.keyAccuracyVerified).length;
  const plantedEligible = generation.filter((g) => g.plantedErrorCaught !== undefined);
  const plantedCaughtCount = plantedEligible.filter((g) => g.plantedErrorCaught).length;
  const crossCheckEligible = generation.filter((g) => g.crossCheckAgreed !== undefined);
  const crossCheckAgreedCount = crossCheckEligible.filter(
    (g) => g.crossCheckAgreed,
  ).length;
  const solverCorrectCount = solver.filter((s) => s.correct).length;

  const allItems: (GenerationItemResult | SolverItemResult)[] = [
    ...generation,
    ...solver,
  ];
  const totalTokens = allItems.reduce(
    (sum, item) => sum + (item.tokensPrompt ?? 0) + (item.tokensCompletion ?? 0),
    0,
  );
  const totalLatency = allItems.reduce((sum, item) => sum + (item.latencyMs ?? 0), 0);

  return {
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    provider: options.provider,
    thresholds: { correctKeys: 0.9, plantedErrorsCaught: 0.9, schemaValid: 0.98 },
    generation,
    solver,
    summary: {
      schemaValidRate: rate(schemaValidCount, generation.length),
      keyAccuracyRate: rate(keyAccurateCount, generation.length),
      plantedErrorCatchRate: rate(plantedCaughtCount, plantedEligible.length),
      crossCheckAgreementRate: rate(crossCheckAgreedCount, crossCheckEligible.length),
      solverAccuracyRate: rate(solverCorrectCount, solver.length),
      totalTokens,
      avgLatencyMs: rate(totalLatency, allItems.length),
    },
  };
}
