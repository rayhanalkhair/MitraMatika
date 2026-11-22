import { describe, expect, it } from "vitest";
import { TokenBudget } from "./budget";
import { createGateway } from "./gateway";
import { createFakeProvider } from "./providers/fake";
import { AiOutputError, AiQuotaError, type AiTask, type RoutingConfig } from "./types";
import { defaultRouting } from "./routing.config";

const routing: RoutingConfig = {
  generate_questions: [
    { provider: "groq", model: "primary", allowedDataClasses: ["C0", "C1", "C2"] },
    { provider: "gemini", model: "fallback", allowedDataClasses: ["C0"] },
  ],
  regenerate_question: [],
  solve_independent: [
    { provider: "groq", model: "checker", allowedDataClasses: ["C0", "C1", "C2"] },
  ],
  ocr_page: [],
  parse_request: [
    { provider: "groq", model: "primary", allowedDataClasses: ["C0", "C1"] },
  ],
};

const parseNumberField = (raw: unknown) => {
  const value = (raw as { n?: unknown }).n;
  if (typeof value !== "number") throw new Error("n harus berupa angka");
  return value;
};

function setup(groqResponses: string[], geminiResponses: string[] = []) {
  const groq = createFakeProvider("groq", groqResponses);
  const gemini = createFakeProvider("gemini", geminiResponses);
  const budget = new TokenBudget({ perMinute: 8000, perDay: 200000 });
  const gateway = createGateway({
    routing,
    providers: { groq, gemini },
    budget,
  });
  return { groq, gemini, budget, gateway };
}

const base = {
  task: "generate_questions" as const,
  system: "s",
  prompt: "p",
  parse: parseNumberField,
};

describe("createGateway", () => {
  it("returns the parsed value with provider and model", async () => {
    const { gateway } = setup(['{"n": 5}']);
    const result = await gateway.generate({ ...base, dataClass: "C0" });
    expect(result).toEqual({
      value: 5,
      provider: "groq",
      model: "primary",
      usage: { inputTokens: 100, outputTokens: 50 },
      attempts: 1,
    });
  });

  it("returns the summed usage and the attempt count", async () => {
    const { gateway } = setup(['{"x": 1}', '{"n": 7}']); // first fails the parse, repair succeeds
    const result = await gateway.generate({ ...base, dataClass: "C0" });
    expect(result.value).toBe(7);
    expect(result.attempts).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 100 });
  });

  it("reports every attempt's usage through onUsage, even when the output is rejected", async () => {
    const { gateway } = setup(['{"x": 1}', '{"x": 2}']);
    const seen: unknown[] = [];
    await expect(
      gateway.generate({
        ...base,
        dataClass: "C0",
        onUsage: (usage) => seen.push(usage),
      }),
    ).rejects.toBeInstanceOf(AiOutputError);
    expect(seen).toEqual([
      { inputTokens: 100, outputTokens: 50 },
      { inputTokens: 100, outputTokens: 50 },
    ]);
  });

  it("still reports the first attempt's usage when the repair is refused by the budget", async () => {
    const groq = createFakeProvider("groq", ['{"x": 1}']);
    const gateway = createGateway({
      routing,
      providers: { groq },
      budget: new TokenBudget({ perMinute: 3000, perDay: 200000 }),
    });
    const seen: unknown[] = [];
    await expect(
      gateway.generate({
        ...base,
        dataClass: "C0",
        onUsage: (usage) => seen.push(usage),
      }),
    ).rejects.toBeInstanceOf(AiQuotaError);
    expect(seen).toEqual([{ inputTokens: 100, outputTokens: 50 }]);
  });

  it("blocks student data before any provider is called", async () => {
    const { gateway, groq, gemini } = setup(['{"n": 1}'], ['{"n": 1}']);
    await expect(gateway.generate({ ...base, dataClass: "C3" })).rejects.toMatchObject({
      code: "student_data_blocked",
    });
    expect(groq.calls).toHaveLength(0);
    expect(gemini.calls).toHaveLength(0);
  });

  it("throws no_eligible_route when the task has no route for the class", async () => {
    const { gateway } = setup([]);
    await expect(
      gateway.generate({ ...base, task: "ocr_page", dataClass: "C2" }),
    ).rejects.toMatchObject({ code: "no_eligible_route" });
  });

  it("never routes uploaded material (C2) to the Gemini fallback", async () => {
    const { gateway, gemini, groq, budget } = setup([], ['{"n": 1}']);
    budget.record("primary", 8000);
    await expect(gateway.generate({ ...base, dataClass: "C2" })).rejects.toBeInstanceOf(
      AiQuotaError,
    );
    expect(groq.calls).toHaveLength(0);
    expect(gemini.calls).toHaveLength(0);
  });

  it("falls back to Gemini for curriculum-only prompts (C0) when the primary is out of budget", async () => {
    const { gateway, groq, gemini, budget } = setup([], ['{"n": 9}']);
    budget.record("primary", 8000);
    const result = await gateway.generate({ ...base, dataClass: "C0" });
    expect(result).toEqual({
      value: 9,
      provider: "gemini",
      model: "fallback",
      usage: { inputTokens: 100, outputTokens: 50 },
      attempts: 1,
    });
    expect(groq.calls).toHaveLength(0);
    expect(gemini.calls).toHaveLength(1);
  });

  it("records spending so a later call can be deferred", async () => {
    const { gateway, budget } = setup(['{"n": 1}']);
    await gateway.generate({ ...base, dataClass: "C2", maxOutputTokens: 7000 });
    expect(budget.canSpend("primary", 2000)).toBe(false);
  });

  it("repairs invalid output once and includes the error in the retry prompt", async () => {
    const { gateway, groq } = setup(["not json", '{"n": 3}']);
    const result = await gateway.generate({ ...base, dataClass: "C0" });
    expect(result.value).toBe(3);
    expect(groq.calls).toHaveLength(2);
    expect(groq.calls[1].prompt).toContain("Keluaran sebelumnya tidak valid");
    expect(groq.calls[1].prompt.startsWith("p")).toBe(true);
  });

  it("throws AiOutputError when the repair also fails", async () => {
    const { gateway, groq } = setup(['{"n": "x"}', '{"n": "y"}']);
    await expect(gateway.generate({ ...base, dataClass: "C0" })).rejects.toBeInstanceOf(
      AiOutputError,
    );
    expect(groq.calls).toHaveLength(2);
  });

  it("reports a routing table that names an unknown provider", async () => {
    const budget = new TokenBudget({ perMinute: 8000, perDay: 200000 });
    const gateway = createGateway({ routing, providers: {}, budget });
    await expect(gateway.generate({ ...base, dataClass: "C0" })).rejects.toThrow(
      /unknown provider/i,
    );
  });

  it("blocks repair retry when budget cannot afford the longer prompt", async () => {
    const groq = createFakeProvider("groq", ["not json", '{"n": 3}']);
    // Use a very limited budget: just enough for the first attempt
    const budget = new TokenBudget({ perMinute: 200, perDay: 200000 });
    const minimalRouting: RoutingConfig = {
      generate_questions: [
        { provider: "groq", model: "primary", allowedDataClasses: ["C0", "C1", "C2"] },
      ],
      regenerate_question: [],
      solve_independent: [],
      ocr_page: [],
      parse_request: [],
    };
    const gateway = createGateway({
      routing: minimalRouting,
      providers: { groq },
      budget,
    });
    // Now attempt a call that will fail JSON parsing and need repair
    // The first attempt will fit in the 200 token budget
    // But the repair with the error message will not
    await expect(
      gateway.generate({
        ...base,
        dataClass: "C0",
        maxOutputTokens: 100,
      }),
    ).rejects.toBeInstanceOf(AiQuotaError);
    // Only the first attempt should have been made, not the repair
    expect(groq.calls).toHaveLength(1);
  });

  it("records both attempt and repair costs when repair succeeds", async () => {
    const groq = createFakeProvider("groq", ["not json", '{"n": 3}']);
    // Each attempt books ~2,001 (first) and ~2,030 (repair), and the fake's 100 input tokens
    // against a 1-token estimate add a 99-token input overrun per attempt: ~4,229 in all, so
    // 4,300 lets the repair through. The last assertion still proves a further call is refused.
    const budget = new TokenBudget({ perMinute: 4300, perDay: 200000 });
    const gateway = createGateway({
      routing,
      providers: { groq },
      budget,
    });
    const singleCallCost = budget.estimate("s" + "p") + 2000;
    // singleCallCost ≈ 1 + 2000 = 2001
    // Budget is 4100, so after first cost (2001), only ~2099 left
    // After repair (which includes error text), ~2036 more, leaving very little
    await gateway.generate({ ...base, dataClass: "C0" });
    // Verify that both costs were recorded by checking we can't spend singleCallCost anymore
    expect(budget.canSpend("primary", singleCallCost)).toBe(false);
  });
});

describe("defaultRouting privacy", () => {
  it("routes a single-question regeneration exactly like a batch generation", () => {
    expect(defaultRouting.regenerate_question).toEqual(defaultRouting.generate_questions);
  });

  it("enforces data class restrictions", () => {
    const allTasks: AiTask[] = [
      "generate_questions",
      "regenerate_question",
      "solve_independent",
      "ocr_page",
      "parse_request",
    ];

    // Verify all tasks are present
    for (const task of allTasks) {
      expect(defaultRouting).toHaveProperty(task);
    }

    // Check every route entry
    for (const task of allTasks) {
      const routes = defaultRouting[task];
      for (const route of routes) {
        // (i) No entry allows C3
        expect(route.allowedDataClasses).not.toContain("C3");

        // (ii) Gemini can only receive C0
        if (route.provider === "gemini") {
          expect(route.allowedDataClasses).toEqual(["C0"]);
        }

        // (iii) C1 and C2 can only go to Groq
        if (
          route.allowedDataClasses.includes("C1") ||
          route.allowedDataClasses.includes("C2")
        ) {
          expect(route.provider).toBe("groq");
        }
      }

      // (iv) ocr_page allows only C1/C2
      if (task === "ocr_page") {
        for (const route of routes) {
          expect(route.allowedDataClasses).toEqual(expect.arrayContaining(["C1", "C2"]));
          expect(route.allowedDataClasses).not.toContain("C0");
          expect(route.allowedDataClasses).not.toContain("C3");
        }
      }
    }
  });
});
