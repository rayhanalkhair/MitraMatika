import { describe, expect, it } from "vitest";
import { TokenBudget } from "@/lib/ai/budget";
import { createGateway } from "@/lib/ai/gateway";
import { createFakeProvider } from "@/lib/ai/providers/fake";
import { defaultRouting } from "@/lib/ai/routing.config";
import type { AiCallRecord } from "@/lib/ai/logging";
import type {
  GoldenGenerationSpec,
  GoldenSolverProblem,
} from "../schema/golden-set-schema";
import { runEval, scoreGenerationSpec, scoreSolverProblem } from "./run-eval";

function validBatchJson(): string {
  return JSON.stringify({
    questions: [
      {
        stem_md: "Berapakah $2+2$?",
        options: [
          { label: "A", text_md: "3" },
          { label: "B", text_md: "4" },
          { label: "C", text_md: "5" },
          { label: "D", text_md: "6" },
        ],
        correctLabel: "B",
        answer: { display_md: "4", machine: "4" },
        explanation_md: "Jumlahkan kedua bilangan.",
        steps: ["Jumlahkan 2 dan 2.", "Hitung $2+2=4$."],
        verification_claims: [{ type: "numeric_eval", expression: "2+2", expected: "4" }],
        metadata: { difficulty: "mudah" },
      },
    ],
  });
}

// Every integer is a root of sin(pi*x)=0 (period 1), so every offset in
// plantError's CORRUPTION_OFFSETS ([1, 1000, 7]) still produces a valid root —
// plantError exhausts its offsets and throws instead of returning a corrupted,
// failing claim. This reproduces the unresolvable-corruption bug.
function unresolvableCorruptionBatchJson(): string {
  return JSON.stringify({
    questions: [
      {
        stem_md: "Berapakah solusi bulat dari $\\sin(\\pi x) = 0$?",
        options: [
          { label: "A", text_md: "0" },
          { label: "B", text_md: "1" },
          { label: "C", text_md: "2" },
          { label: "D", text_md: "3" },
        ],
        correctLabel: "B",
        answer: { display_md: "1", machine: "1" },
        explanation_md: "Setiap bilangan bulat adalah akar persamaan ini.",
        steps: [
          "Perhatikan periode fungsi sinus.",
          "Setiap bilangan bulat memenuhi persamaan.",
        ],
        verification_claims: [
          {
            type: "equation_solution",
            equation: "sin(pi*x)=0",
            variable: "x",
            solutions: ["1"],
          },
        ],
        metadata: { difficulty: "mudah" },
      },
    ],
  });
}

function agreeingSolveJson(): string {
  return JSON.stringify({
    correctLabel: "B",
    answer: { display_md: "4", machine: "4" },
    steps: ["Hitung $2+2=4$."],
  });
}

function disagreeingSolveJson(): string {
  return JSON.stringify({
    correctLabel: "A",
    answer: { display_md: "3", machine: "3" },
    steps: ["Langkah keliru."],
  });
}

function spec(): GoldenGenerationSpec {
  return {
    id: "bilangan-mudah-1",
    grade: 8,
    topicStableKey: "bilangan-berpangkat-dan-bentuk-akar",
    topicTitle: "Bilangan Berpangkat",
    difficulty: "mudah",
    count: 1,
    sourceRef: "test",
  };
}

const topicScopeNotes = new Map([
  ["bilangan-berpangkat-dan-bentuk-akar", "Operasi bilangan berpangkat."],
]);

function gatewayWith(responses: string[]) {
  const fake = createFakeProvider("groq", responses);
  return createGateway({
    routing: defaultRouting,
    providers: { groq: fake },
    budget: new TokenBudget({ perMinute: 100000, perDay: 1000000 }),
  });
}

describe("scoreGenerationSpec", () => {
  it("scores a fully successful generation: schema-valid, key-accurate, planted error caught, cross-check agrees", async () => {
    const gateway = gatewayWith([validBatchJson(), agreeingSolveJson()]);
    const callLog: AiCallRecord[] = [];

    const result = await scoreGenerationSpec(gateway, spec(), topicScopeNotes, callLog);

    expect(result.ok).toBe(true);
    expect(result.schemaValid).toBe(true);
    expect(result.keyAccuracyVerified).toBe(true);
    expect(result.plantedErrorCaught).toBe(true);
    expect(result.crossCheckAgreed).toBe(true);
    expect(result.question?.stem_md).toContain("2+2");
    // The fake provider never calls a logger, so bracketed totals stay at 0 —
    // this is expected in fake mode, not a bug.
    expect(result.tokensPrompt).toBe(0);
  });

  it("reports crossCheckAgreed=false when the independent solver disagrees", async () => {
    const gateway = gatewayWith([validBatchJson(), disagreeingSolveJson()]);

    const result = await scoreGenerationSpec(gateway, spec(), topicScopeNotes, []);

    expect(result.crossCheckAgreed).toBe(false);
  });

  it("reports ok=false and schemaValid=false when generation never produces valid JSON", async () => {
    const gateway = gatewayWith(["not json", "still not json"]);

    const result = await scoreGenerationSpec(gateway, spec(), topicScopeNotes, []);

    expect(result.ok).toBe(false);
    expect(result.schemaValid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("keeps a successful generation when only the cross-check call fails", async () => {
    const gateway = gatewayWith([validBatchJson(), "not json", "still not json"]);

    const result = await scoreGenerationSpec(gateway, spec(), topicScopeNotes, []);

    expect(result.ok).toBe(true);
    expect(result.schemaValid).toBe(true);
    expect(result.question).toBeDefined();
    expect(result.keyAccuracyVerified).toBeDefined();
    expect(result.crossCheckAgreed).toBeUndefined();
    expect(result.crossCheckError).toBeDefined();
  });

  it("keeps a successful generation when plantError can't corrupt an unresolvable claim (e.g. sin(pi*x)=0)", async () => {
    const gateway = gatewayWith([unresolvableCorruptionBatchJson(), agreeingSolveJson()]);

    const result = await scoreGenerationSpec(gateway, spec(), topicScopeNotes, []);

    expect(result.ok).toBe(true);
    expect(result.schemaValid).toBe(true);
    expect(result.question).toBeDefined();
    expect(result.keyAccuracyVerified).toBe(true);
    expect(result.plantedErrorCaught).toBeUndefined();
    expect(result.plantedErrorCheckError).toBeDefined();
    expect(result.crossCheckAgreed).toBeDefined();
  });

  it("reports an error when the topic's scope notes can't be found", async () => {
    const gateway = gatewayWith([]);

    const result = await scoreGenerationSpec(gateway, spec(), new Map(), []);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("bilangan-berpangkat-dan-bentuk-akar");
  });
});

function solverProblem(): GoldenSolverProblem {
  return {
    id: "pythagoras-1",
    grade: 8,
    topicStableKey: "teorema-pythagoras",
    difficulty: "mudah",
    stem_md: "Sisi siku-siku 9 cm dan 12 cm, berapa hipotenusa?",
    options: [
      { label: "A", text_md: "15 cm" },
      { label: "B", text_md: "18 cm" },
      { label: "C", text_md: "21 cm" },
      { label: "D", text_md: "225 cm" },
    ],
    correctLabel: "A",
    answer: { display_md: "15 cm", machine: "15" },
    sourceRef: "test",
  };
}

describe("scoreSolverProblem", () => {
  it("marks correct=true when the solver agrees with the known answer", async () => {
    const gateway = gatewayWith([
      JSON.stringify({
        correctLabel: "A",
        answer: { display_md: "15 cm", machine: "15" },
        steps: ["Pythagoras."],
      }),
    ]);

    const result = await scoreSolverProblem(gateway, solverProblem(), []);

    expect(result.ok).toBe(true);
    expect(result.correct).toBe(true);
  });

  it("marks correct=false when the solver disagrees", async () => {
    const gateway = gatewayWith([
      JSON.stringify({
        correctLabel: "B",
        answer: { display_md: "18 cm", machine: "18" },
        steps: ["Keliru."],
      }),
    ]);

    const result = await scoreSolverProblem(gateway, solverProblem(), []);

    expect(result.ok).toBe(true);
    expect(result.correct).toBe(false);
  });

  it("reports ok=false when the solver call never produces valid JSON", async () => {
    const gateway = gatewayWith(["not json", "still not json"]);

    const result = await scoreSolverProblem(gateway, solverProblem(), []);

    expect(result.ok).toBe(false);
    expect(result.correct).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("runEval", () => {
  it("aggregates generation and solver results into summary rates", async () => {
    const gateway = gatewayWith([
      validBatchJson(), // spec 1: generate — succeeds
      agreeingSolveJson(), // spec 1: cross-check — agrees
      "not json", // spec 2: generate attempt 1 — fails
      "still not json", // spec 2: generate attempt 2 — fails, throws
      JSON.stringify({
        correctLabel: "A",
        answer: { display_md: "15 cm", machine: "15" },
        steps: ["Pythagoras."],
      }), // solver problem 1 — correct
    ]);

    const specs: GoldenGenerationSpec[] = [spec(), { ...spec(), id: "spec-2" }];
    const problems: GoldenSolverProblem[] = [solverProblem()];

    const report = await runEval(gateway, specs, problems, topicScopeNotes, [], {
      provider: "fake",
      now: () => "2026-09-26T00:00:00.000Z",
    });

    expect(report.generation).toHaveLength(2);
    expect(report.solver).toHaveLength(1);
    expect(report.summary.schemaValidRate).toBe(0.5);
    expect(report.summary.keyAccuracyRate).toBe(0.5);
    expect(report.summary.plantedErrorCatchRate).toBe(1);
    expect(report.summary.crossCheckAgreementRate).toBe(1);
    expect(report.summary.solverAccuracyRate).toBe(1);
    expect(report.generatedAt).toBe("2026-09-26T00:00:00.000Z");
    expect(report.provider).toBe("fake");
    expect(report.thresholds).toEqual({
      correctKeys: 0.9,
      plantedErrorsCaught: 0.9,
      schemaValid: 0.98,
    });
  });

  it("does not divide by zero when there are no generation specs or no solver problems", async () => {
    const gateway = gatewayWith([]);

    const report = await runEval(gateway, [], [], topicScopeNotes, [], {
      provider: "fake",
      now: () => "2026-09-26T00:00:00.000Z",
    });

    expect(report.summary.schemaValidRate).toBe(0);
    expect(report.summary.solverAccuracyRate).toBe(0);
    expect(report.summary.avgLatencyMs).toBe(0);
  });

  it("sleeps delayMs once after each generation item and each solver item when delayMs is set", async () => {
    const gateway = gatewayWith([
      validBatchJson(),
      agreeingSolveJson(),
      validBatchJson(),
      agreeingSolveJson(),
      JSON.stringify({
        correctLabel: "A",
        answer: { display_md: "15 cm", machine: "15" },
        steps: ["Pythagoras."],
      }),
    ]);
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };

    const report = await runEval(
      gateway,
      [spec(), { ...spec(), id: "spec-2" }],
      [solverProblem()],
      topicScopeNotes,
      [],
      { provider: "fake", now: () => "2026-09-26T00:00:00.000Z", delayMs: 45000, sleep },
    );

    expect(report.generation).toHaveLength(2);
    expect(report.solver).toHaveLength(1);
    expect(sleeps).toEqual([45000, 45000, 45000]);
  });

  it("never sleeps when delayMs is omitted", async () => {
    const gateway = gatewayWith([
      validBatchJson(),
      agreeingSolveJson(),
      JSON.stringify({
        correctLabel: "A",
        answer: { display_md: "15 cm", machine: "15" },
        steps: ["Pythagoras."],
      }),
    ]);
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };

    await runEval(gateway, [spec()], [solverProblem()], topicScopeNotes, [], {
      provider: "fake",
      now: () => "2026-09-26T00:00:00.000Z",
      sleep,
    });

    expect(sleeps).toEqual([]);
  });
});
