import { describe, expect, it } from "vitest";
import { TokenBudget } from "./budget";
import { resetE2eAi } from "./e2e/control";
import {
  createFakeAiBudget,
  createRuntimeGateway,
  createRuntimeProviders,
  routingFor,
} from "./runtime";
import { defaultRouting } from "./routing.config";

describe("createRuntimeProviders", () => {
  it("creates a provider per configured key", () => {
    expect(Object.keys(createRuntimeProviders({ GROQ_API_KEY: "k" }))).toEqual(["groq"]);
    expect(
      Object.keys(
        createRuntimeProviders({ GROQ_API_KEY: "k", GOOGLE_API_KEY: "g" }),
      ).sort(),
    ).toEqual(["gemini", "groq"]);
    expect(createRuntimeProviders({})).toEqual({});
  });
});

describe("routingFor", () => {
  it("drops routes whose provider is not configured", () => {
    const providers = createRuntimeProviders({ GROQ_API_KEY: "k" });
    const routing = routingFor(providers);
    expect(routing.generate_questions.map((route) => route.provider)).toEqual(["groq"]);
    expect(routing.parse_request.map((route) => route.provider)).toEqual(["groq"]);
  });

  it("keeps every route when every provider is configured", () => {
    const providers = createRuntimeProviders({ GROQ_API_KEY: "k", GOOGLE_API_KEY: "g" });
    expect(routingFor(providers)).toEqual(defaultRouting);
  });

  it("leaves a task with no routes when no provider is configured", () => {
    expect(routingFor({}).generate_questions).toEqual([]);
  });
});

describe("createRuntimeProviders with the e2e fake AI", () => {
  const on = { E2E_FAKE_AI: "1", NODE_ENV: "development" };

  it("returns scripted providers named groq and gemini and ignores keys", () => {
    const providers = createRuntimeProviders({}, on);
    expect(Object.keys(providers).sort()).toEqual(["gemini", "groq"]);
    expect(providers.groq.name).toBe("groq");
    expect(providers.gemini.name).toBe("gemini");
    expect(routingFor(providers)).toEqual(defaultRouting);
  });

  it("returns the real providers in production even with the flag", () => {
    const providers = createRuntimeProviders(
      { GROQ_API_KEY: "k" },
      { E2E_FAKE_AI: "1", NODE_ENV: "production" },
    );
    expect(Object.keys(providers)).toEqual(["groq"]);
  });

  it("returns the real providers without the flag", () => {
    expect(createRuntimeProviders({}, { NODE_ENV: "development" })).toEqual({});
  });
});

describe("createRuntimeGateway with the e2e fake AI", () => {
  const exhausted = () => new TokenBudget({ perMinute: 1, perDay: 1 });
  const request = {
    task: "solve_independent" as const,
    dataClass: "C0" as const,
    system: "s",
    prompt: "Soal: Hitung $2 + 2$.",
    parse: (raw: unknown) => raw,
  };

  it("ignores the caller's budget and answers from the scripted provider", async () => {
    const result = await createRuntimeGateway(exhausted(), {
      E2E_FAKE_AI: "1",
      NODE_ENV: "development",
    }).generate(request);
    expect(result.provider).toBe("groq");
    expect(result.value).toMatchObject({ correctLabel: "B" });
    resetE2eAi();
  });

  it("keeps the caller's budget in production even with the flag", async () => {
    const gateway = createRuntimeGateway(exhausted(), {
      E2E_FAKE_AI: "1",
      NODE_ENV: "production",
    });
    await expect(gateway.generate(request)).rejects.toThrow();
  });
});

describe("createFakeAiBudget", () => {
  it("lets paced calls through without waiting in real time", async () => {
    const budget = createFakeAiBudget();
    const started = Date.now();
    const output = { tokens: 900, otpm: 1000 };
    expect(await budget.book("vision", 3_000, { output })).toBe(true);
    expect(await budget.book("vision", 3_000, { output })).toBe(true);
    expect(await budget.book("vision", 3_000, { output })).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
