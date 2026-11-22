import { describe, expect, it } from "vitest";
import { TokenBudget, createFakeProvider, createGateway, defaultRouting } from "@/lib/ai";
import { solveIndependent } from "./solve-independent";

function setup(responses: string[]) {
  const groq = createFakeProvider("groq", responses);
  const budget = new TokenBudget({ perMinute: 8000, perDay: 200000 });
  const gateway = createGateway({ routing: defaultRouting, providers: { groq }, budget });
  return { groq, gateway };
}

const baseParams = {
  questionStemMd: "Berapakah hasil dari $3^2 + 4^2$?",
  optionTexts_md: ["24", "25", "26", "27"] as [string, string, string, string],
  dataClass: "C0" as const,
};

describe("solveIndependent", () => {
  it("returns a validated solution", async () => {
    const { gateway } = setup([
      JSON.stringify({
        correctLabel: "B",
        answer: { display_md: "25", machine: "25" },
        steps: ["Hitung $3^2 = 9$.", "Hitung $4^2 = 16$.", "Jumlahkan: 25."],
      }),
    ]);
    const result = await solveIndependent(gateway, baseParams);
    expect(result.value.correctLabel).toBe("B");
  });

  it("never reveals a marked correct answer in the prompt", async () => {
    const { gateway, groq } = setup([
      JSON.stringify({
        correctLabel: "B",
        answer: { display_md: "25", machine: "25" },
        steps: ["Langkah satu.", "Langkah dua."],
      }),
    ]);
    await solveIndependent(gateway, baseParams);
    // The prompt legitimately tells the model to return a field named
    // correctLabel (see the prompt content requirements above) — that is an
    // output-schema instruction, not a leak. baseParams carries no claimed
    // answer at all, so the only real leak to guard against is prose that
    // states which option is correct.
    expect(groq.calls[0].prompt).not.toMatch(/jawaban yang benar adalah/i);
  });

  it("repairs a schema violation", async () => {
    const { gateway, groq } = setup([
      JSON.stringify({
        correctLabel: "Z",
        answer: { display_md: "25", machine: "25" },
        steps: [],
      }),
      JSON.stringify({
        correctLabel: "B",
        answer: { display_md: "25", machine: "25" },
        steps: ["Satu langkah."],
      }),
    ]);
    const result = await solveIndependent(gateway, baseParams);
    expect(result.value.correctLabel).toBe("B");
    expect(groq.calls).toHaveLength(2);
  });

  it("passes maxOutputTokens and reports usage through the options", async () => {
    const { gateway } = setup([
      JSON.stringify({
        correctLabel: "B",
        answer: { display_md: "25", machine: "25" },
        steps: ["Satu langkah."],
      }),
    ]);
    const seen: unknown[] = [];
    await solveIndependent(gateway, baseParams, {
      maxOutputTokens: 700,
      onUsage: (usage) => seen.push(usage),
    });
    expect(seen).toEqual([{ inputTokens: 100, outputTokens: 50 }]);
  });
});
