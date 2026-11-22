import { afterEach, describe, expect, it } from "vitest";
import { buildGenerateMcPrompt } from "@/features/generation/service/prompts/generate-mc.id";
import { buildSolveIndependentPrompt } from "@/features/generation/service/prompts/solve-independent.id";
import { defaultRouting } from "@/lib/ai/routing.config";
import { AiProviderError } from "@/lib/ai/types";
import { getE2eAiState, resetE2eAi, setScenario } from "@/lib/ai/e2e/control";
import { createScriptedProvider } from "@/lib/ai/e2e/scripted-provider";
import { validateCitations } from "./citations";

afterEach(() => {
  resetE2eAi();
});

const parseText = (text: string) =>
  JSON.parse(text) as { questions: unknown[]; answer: { machine: string } };

const GENERATE_MODEL = defaultRouting.generate_questions[0].model;
const SOLVE_MODEL = defaultRouting.solve_independent[0].model;

const pack = {
  grade: 8 as const,
  topicTitle: "SPLDV",
  topicScopeNotes: "Sistem persamaan linear dua variabel.",
  difficulty: "sedang" as const,
  dataClass: "C0" as const,
};
const generateCall = (count: number, correctionNote?: string) => {
  const { system, prompt } = buildGenerateMcPrompt({ ...pack, count, correctionNote });
  return [GENERATE_MODEL, system, prompt] as const;
};
const solverCall = (n: number) => {
  const { system, prompt } = buildSolveIndependentPrompt({
    questionStemMd: `Hitung $${String(n)} + ${String(n)}$.`,
    optionTexts_md: ["1", "2", "3", "4"],
    dataClass: "C0",
  });
  return [SOLVE_MODEL, system, prompt] as const;
};

describe("createScriptedProvider", () => {
  it("has the requested name and reports usage", async () => {
    const provider = createScriptedProvider("gemini");
    expect(provider.name).toBe("gemini");
    const completion = await provider.complete(...generateCall(2));
    expect(completion.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("tells generate, solver and regeneration apart and counts each", async () => {
    const provider = createScriptedProvider("groq");
    const batch = await provider.complete(...generateCall(3));
    expect(parseText(batch.text).questions).toHaveLength(3);
    const solved = await provider.complete(...solverCall(4));
    expect(parseText(solved.text).answer.machine).toBe("8");
    const regenerated = await provider.complete(
      ...generateCall(1, "Klaim gagal: 1+1 bukan 99"),
    );
    expect(parseText(regenerated.text).questions).toHaveLength(1);
    expect(getE2eAiState().calls).toEqual({ generate: 1, regenerate: 1, solver: 1 });
    expect(getE2eAiState().log).toHaveLength(3);
  });

  it("answers a solver call with the letter of the option that holds the answer", async () => {
    const provider = createScriptedProvider("groq");
    const { system, prompt } = buildSolveIndependentPrompt({
      questionStemMd: "Hitung $3 + 3$.",
      optionTexts_md: ["7", "5", "6", "8"],
      dataClass: "C0",
    });
    const solved = await provider.complete(SOLVE_MODEL, system, prompt);
    expect(parseText(solved.text)).toMatchObject({
      correctLabel: "C",
      answer: { machine: "6" },
    });
  });

  it("treats a one-question request without a correction note as a plain generate call", async () => {
    const provider = createScriptedProvider("groq");
    await provider.complete(...generateCall(1));
    expect(getE2eAiState().calls).toEqual({ generate: 1, regenerate: 0, solver: 0 });
  });

  it("serves the repair retry as the next generate call", async () => {
    setScenario("malformed_repairable");
    const provider = createScriptedProvider("groq");
    const [model, system, prompt] = generateCall(5);
    expect((await provider.complete(model, system, prompt)).text).toBe("not json");
    const repair = `${prompt}\n\nKeluaran sebelumnya tidak valid: x. Kembalikan hanya JSON yang valid.`;
    const retried = await provider.complete(model, system, repair);
    expect(parseText(retried.text).questions).toHaveLength(5);
  });

  it("throws the scripted provider error and flips rate_limited to valid", async () => {
    setScenario("rate_limited");
    const provider = createScriptedProvider("groq");
    await expect(provider.complete(...generateCall(5))).rejects.toBeInstanceOf(
      AiProviderError,
    );
    expect(getE2eAiState().scenario).toBe("valid");
    const retry = await provider.complete(...generateCall(5));
    expect(parseText(retry.text).questions).toHaveLength(5);
  });

  it("throws a descriptive error for a generate prompt that does not say how many questions", async () => {
    const provider = createScriptedProvider("groq");
    await expect(provider.complete(GENERATE_MODEL, "s", "tanpa jumlah")).rejects.toThrow(
      "e2e scripted AI: scenario=valid task=generate call=0 has no scripted answer",
    );
  });

  it("throws for an unknown model", async () => {
    const provider = createScriptedProvider("groq");
    await expect(provider.complete("some/other-model", "s", "p")).rejects.toThrow(
      /scenario=valid task=unknown call=0 has no scripted answer/,
    );
  });

  it("throws when the solver prompt does not identify the question", async () => {
    const provider = createScriptedProvider("groq");
    await expect(provider.complete(SOLVE_MODEL, "s", "Soal: lain")).rejects.toThrow(
      /scenario=valid task=solver call=0 has no scripted answer/,
    );
  });

  it("cites the material passages the prompt offered; invented_citation breaks question 1", async () => {
    const { system, prompt } = buildGenerateMcPrompt({
      ...pack,
      dataClass: "C2",
      count: 3,
      passages: [
        { id: "P2", text: "Sistem persamaan linear dua variabel." },
        { id: "P3", text: "Contoh sistem persamaan linear dua variabel." },
      ],
    });
    const provider = createScriptedProvider("groq");
    const questions = (text: string) =>
      (JSON.parse(text) as { questions: { citations?: string[] }[] }).questions;
    const ids = ["P2", "P3"];

    const valid = questions(
      (await provider.complete(GENERATE_MODEL, system, prompt)).text,
    );
    expect(valid.map((question) => validateCitations(question, ids).ok)).toEqual([
      true,
      true,
      true,
    ]);

    setScenario("invented_citation");
    const invented = questions(
      (await provider.complete(GENERATE_MODEL, system, prompt)).text,
    );
    expect(invented.map((question) => validateCitations(question, ids).ok)).toEqual([
      false,
      true,
      true,
    ]);
  });
});
