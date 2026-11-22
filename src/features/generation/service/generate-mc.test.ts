import { describe, expect, it } from "vitest";
import { TokenBudget, createFakeProvider, createGateway, defaultRouting } from "@/lib/ai";
import { generateMultipleChoiceBatch } from "./generate-mc";

function validBatchJson() {
  return JSON.stringify({
    questions: [
      {
        stem_md: "Berapakah hasil dari $3^2 + 4^2$?",
        options: [
          { label: "A", text_md: "24" },
          { label: "B", text_md: "25" },
          { label: "C", text_md: "26" },
          { label: "D", text_md: "27" },
        ],
        correctLabel: "B",
        answer: { display_md: "25", machine: "25" },
        explanation_md: "Gunakan penjumlahan kuadrat.",
        steps: ["Hitung $3^2 = 9$.", "Hitung $4^2 = 16$.", "Jumlahkan: $9 + 16 = 25$."],
        verification_claims: [
          { type: "numeric_eval", expression: "3^2 + 4^2", expected: "25" },
        ],
        metadata: { difficulty: "sedang" },
      },
    ],
  });
}

function setup(responses: string[]) {
  const groq = createFakeProvider("groq", responses);
  const budget = new TokenBudget({ perMinute: 8000, perDay: 200000 });
  const gateway = createGateway({ routing: defaultRouting, providers: { groq }, budget });
  return { groq, gateway };
}

const baseParams = {
  grade: 8 as const,
  topicTitle: "Teorema Pythagoras",
  topicScopeNotes: "Menghitung sisi segitiga siku-siku.",
  difficulty: "sedang" as const,
  count: 1,
  dataClass: "C0" as const,
};

describe("generateMultipleChoiceBatch", () => {
  it("returns a validated batch on a well-formed response", async () => {
    const { gateway } = setup([validBatchJson()]);
    const result = await generateMultipleChoiceBatch(gateway, baseParams);
    expect(result.value.questions).toHaveLength(1);
    expect(result.value.questions[0].correctLabel).toBe("B");
  });

  it("repairs a schema violation using the gateway's existing retry", async () => {
    const badBatch = JSON.parse(validBatchJson()) as {
      questions: { options: unknown[]; stem_md: string }[];
    };
    badBatch.questions[0].options = badBatch.questions[0].options.slice(0, 3);
    const { gateway, groq } = setup([JSON.stringify(badBatch), validBatchJson()]);
    const result = await generateMultipleChoiceBatch(gateway, baseParams);
    expect(result.value.questions).toHaveLength(1);
    expect(groq.calls).toHaveLength(2);
  });

  it("repairs an invalid KaTeX span using the gateway's existing retry", async () => {
    const badBatch = JSON.parse(validBatchJson()) as {
      questions: { options: unknown[]; stem_md: string }[];
    };
    badBatch.questions[0].stem_md = "Nilai dari $\\notarealcommand$?";
    const { gateway, groq } = setup([JSON.stringify(badBatch), validBatchJson()]);
    const result = await generateMultipleChoiceBatch(gateway, baseParams);
    expect(result.value.questions).toHaveLength(1);
    expect(groq.calls).toHaveLength(2);
  });

  it("includes the grade, topic and difficulty in the prompt", async () => {
    const { gateway, groq } = setup([validBatchJson()]);
    await generateMultipleChoiceBatch(gateway, baseParams);
    expect(groq.calls[0].prompt).toContain("Teorema Pythagoras");
    expect(groq.calls[0].prompt).toMatch(/kelas 8|grade 8/i);
    expect(groq.calls[0].prompt).toMatch(/sedang/i);
  });

  it("spells out every literal JSON field name the schema expects, not just a placeholder", async () => {
    const { gateway, groq } = setup([validBatchJson()]);
    await generateMultipleChoiceBatch(gateway, baseParams);
    const prompt = groq.calls[0].prompt;
    // Regression guard for a real bug: a real Groq call once returned
    // question_md/choices/no-answer-object because the prompt only said
    // "{ ... }" instead of spelling out the actual field names below.
    for (const field of [
      "stem_md",
      "text_md",
      "correctLabel",
      "display_md",
      "machine",
      "explanation_md",
      "verification_claims",
      "expected",
      "metadata",
      "difficulty",
    ]) {
      expect(prompt).toContain(field);
    }
  });

  it("passes maxOutputTokens and reports usage through the options", async () => {
    const { gateway } = setup([validBatchJson()]);
    const seen: unknown[] = [];
    await generateMultipleChoiceBatch(gateway, baseParams, {
      maxOutputTokens: 700,
      onUsage: (usage) => seen.push(usage),
    });
    expect(seen).toEqual([{ inputTokens: 100, outputTokens: 50 }]);
  });
});
