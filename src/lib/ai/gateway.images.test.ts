import { describe, expect, it } from "vitest";
import { TokenBudget } from "./budget";
import {
  createGateway,
  MAX_IMAGES_BASE64_CHARS,
  MAX_IMAGES_PER_REQUEST,
  PROVIDER_CAP_CEILING,
} from "./gateway";
import { createFakeProvider } from "./providers/fake";
import { defaultRouting } from "./routing.config";
import {
  AI_TASKS,
  AiImageError,
  AiQuotaError,
  type AiImage,
  type RoutingConfig,
} from "./types";

// The 8-byte PNG signature and the 3-byte JPEG start, base64-encoded.
const PNG: AiImage = { mime: "image/png", base64: "iVBORw0KGgo=" };
const JPEG: AiImage = { mime: "image/jpeg", base64: "/9j/4AAQ" };

// A PNG-signed base64 string of exactly `length` characters (a multiple of 4).
function pngOfLength(length: number): AiImage {
  return { mime: "image/png", base64: "iVBORw0KGgoA" + "A".repeat(length - 12) };
}

const routing: RoutingConfig = {
  ocr_page: [
    {
      provider: "groq",
      model: "vision",
      allowedDataClasses: ["C1", "C2"],
      vision: true,
      otpm: 1000,
      maxOutputTokens: 900,
    },
  ],
  propose_structure: [
    { provider: "groq", model: "text", allowedDataClasses: ["C1", "C2"] },
  ],
  solve_problem: [
    { provider: "gemini", model: "fallback", allowedDataClasses: ["C0", "C1"] },
    { provider: "groq", model: "solver", allowedDataClasses: ["C2"] },
  ],
  alternative_method: [
    { provider: "gemini", model: "fallback", allowedDataClasses: ["C0", "C1"] },
  ],
};

const parseAny = (raw: unknown) => raw;

function setup(responses: string[], limits = { perMinute: 100_000, perDay: 1_000_000 }) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const groq = createFakeProvider("groq", responses);
  const gemini = createFakeProvider("gemini", ['{"n": 1}']);
  const budget = new TokenBudget(
    limits,
    () => now,
    // The clock moves when the sleep resolves (a microtask later), as with a real timer.
    (ms) => {
      sleeps.push(ms);
      return Promise.resolve().then(() => {
        now += ms;
      });
    },
  );
  const gateway = createGateway({ routing, providers: { groq, gemini }, budget });
  return { groq, gemini, budget, gateway, sleeps };
}

const ocr = {
  task: "ocr_page" as const,
  dataClass: "C2" as const,
  system: "s",
  prompt: "p",
  parse: parseAny,
};

describe("gateway image input", () => {
  it("passes the images and the route's output cap to the provider", async () => {
    const { gateway, groq } = setup(['{"md": "x"}']);
    await gateway.generate({ ...ocr, images: [PNG] });
    expect(groq.calls).toEqual([
      {
        model: "vision",
        system: "s",
        prompt: "p",
        options: { images: [PNG], maxOutputTokens: 900 },
      },
    ]);
  });

  it("never raises the output cap above the route's", async () => {
    const { gateway, groq } = setup(['{"md": "x"}']);
    await gateway.generate({ ...ocr, images: [PNG], maxOutputTokens: 5000 });
    expect(groq.calls[0].options?.maxOutputTokens).toBe(900);
  });

  it("sends the images again on the repair attempt", async () => {
    const { gateway, groq } = setup(["not json", '{"md": "x"}']);
    await gateway.generate({ ...ocr, images: [PNG] });
    expect(groq.calls).toHaveLength(2);
    expect(groq.calls[1].options?.images).toEqual([PNG]);
  });

  it("refuses an image request when no eligible route accepts images", async () => {
    const { gateway, groq } = setup(['{"n": 1}']);
    await expect(
      gateway.generate({ ...ocr, task: "propose_structure", images: [PNG] }),
    ).rejects.toMatchObject({ code: "no_eligible_route" });
    expect(groq.calls).toHaveLength(0);
  });

  it("keeps the base64 total under Groq's 4 MB request limit, with headroom", () => {
    expect(MAX_IMAGES_BASE64_CHARS).toBeLessThanOrEqual(3.5 * 1024 * 1024);
  });

  it("refuses images whose base64 total is over the limit before any call", async () => {
    const { gateway, groq } = setup(['{"n": 1}']);
    const half = pngOfLength(MAX_IMAGES_BASE64_CHARS / 2 + 4);
    const error = await gateway
      .generate({ ...ocr, images: [half, half] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiImageError);
    expect(error).toMatchObject({ code: "image_too_large" });
    expect(groq.calls).toHaveLength(0);
  });

  it("accepts images whose base64 total is exactly at the limit", async () => {
    const { gateway } = setup(['{"n": 1}']);
    const half = pngOfLength(MAX_IMAGES_BASE64_CHARS / 2);
    await expect(
      gateway.generate({ ...ocr, images: [half, half] }),
    ).resolves.toBeDefined();
  });

  it("caps the number of images per request", async () => {
    const { gateway, groq } = setup(['{"n": 1}']);
    expect(MAX_IMAGES_PER_REQUEST).toBe(4);
    await expect(
      gateway.generate({ ...ocr, images: [PNG, PNG, PNG, PNG, PNG] }),
    ).rejects.toMatchObject({ code: "too_many_images" });
    expect(groq.calls).toHaveLength(0);
    await expect(
      gateway.generate({ ...ocr, images: [PNG, JPEG, PNG, JPEG] }),
    ).resolves.toBeDefined();
  });

  it.each([
    ["a length that is not a multiple of 4", "iVBORw0KGgo"],
    ["characters outside the base64 alphabet", "iVBORw0K$$$="],
    ["padding before the end", "iVBO=w0KGgo="],
    ["more than two padding characters", "iVBORw0KG==="],
    ["a data URL instead of bare base64", "data:image/png;base64,iVBORw0KGgo="],
    ["an empty string", ""],
  ])("refuses base64 with %s", async (_label, base64) => {
    const { gateway, groq } = setup(['{"n": 1}']);
    await expect(
      gateway.generate({ ...ocr, images: [{ mime: "image/png", base64 }] }),
    ).rejects.toMatchObject({ code: "image_invalid" });
    expect(groq.calls).toHaveLength(0);
  });

  it("refuses bytes that do not match the declared type", async () => {
    const { gateway, groq } = setup(['{"n": 1}']);
    await expect(
      gateway.generate({ ...ocr, images: [{ mime: "image/png", base64: JPEG.base64 }] }),
    ).rejects.toMatchObject({ code: "image_type_unsupported" });
    await expect(
      gateway.generate({ ...ocr, images: [{ mime: "image/jpeg", base64: PNG.base64 }] }),
    ).rejects.toMatchObject({ code: "image_type_unsupported" });
    // GIF bytes ("GIF89a") declared as PNG.
    await expect(
      gateway.generate({ ...ocr, images: [{ mime: "image/png", base64: "R0lGODlh" }] }),
    ).rejects.toMatchObject({ code: "image_type_unsupported" });
    expect(groq.calls).toHaveLength(0);
  });

  it("treats a request with images as C2 whatever class the caller declared", async () => {
    const { groq } = setup([]);
    const leaky = createGateway({
      routing: {
        ocr_page: [
          {
            provider: "groq",
            model: "vision",
            allowedDataClasses: ["C0", "C1"],
            vision: true,
          },
        ],
      },
      providers: { groq },
      budget: new TokenBudget({ perMinute: 100_000, perDay: 1_000_000 }),
    });
    for (const dataClass of ["C0", "C1"] as const) {
      await expect(
        leaky.generate({ ...ocr, dataClass, images: [PNG] }),
      ).rejects.toMatchObject({ code: "no_eligible_route" });
    }
    expect(groq.calls).toHaveLength(0);
  });

  it("still sends a C1-declared image request to a route that allows C2", async () => {
    const { gateway, groq } = setup(['{"n": 1}']);
    await gateway.generate({ ...ocr, dataClass: "C1", images: [PNG] });
    expect(groq.calls).toHaveLength(1);
  });

  it("refuses an image type other than PNG or JPEG", async () => {
    const { gateway, groq } = setup(['{"n": 1}']);
    const gif = { mime: "image/gif", base64: "R0lGOD" } as unknown as AiImage;
    await expect(gateway.generate({ ...ocr, images: [gif] })).rejects.toMatchObject({
      code: "image_type_unsupported",
    });
    expect(groq.calls).toHaveLength(0);
  });

  it("budgets 2,048 input tokens per image", async () => {
    // 2,000 tokens a minute: the 900-token output fits, the image's 2,048 do not.
    const { gateway, groq } = setup(['{"n": 1}'], {
      perMinute: 2_000,
      perDay: 1_000_000,
    });
    await expect(gateway.generate({ ...ocr, images: [PNG] })).rejects.toBeInstanceOf(
      AiQuotaError,
    );
    expect(groq.calls).toHaveLength(0);
  });
});

describe("gateway provider output cap", () => {
  // A text route without its own cap, as generate_questions is today.
  function textGateway(usage = { inputTokens: 100, outputTokens: 50 }) {
    const groq = createFakeProvider("groq", ['{"n": 1}'], usage);
    const budget = new TokenBudget({ perMinute: 100_000, perDay: 1_000_000 }, () => 0);
    const gateway = createGateway({
      routing: {
        generate_questions: [
          { provider: "groq", model: "text", allowedDataClasses: ["C0", "C1", "C2"] },
        ],
      },
      providers: { groq },
      budget,
    });
    const request = {
      ...ocr,
      task: "generate_questions" as const,
      dataClass: "C0" as const,
    };
    return { groq, budget, gateway, request };
  }

  it.each([
    ["a one-question generation (700 reserved)", 700, 2_100],
    ["a 5-question batch (3,500 reserved)", 3_500, 10_500],
    ["the default reservation (2,000)", undefined, 6_000],
    ["a reservation whose triple is over the ceiling", 6_000, PROVIDER_CAP_CEILING],
  ])("always sends a hard cap of three times %s", async (_label, reserved, cap) => {
    const { groq, gateway, request } = textGateway();
    await gateway.generate({ ...request, maxOutputTokens: reserved });
    expect(groq.calls[0].options).toEqual({ maxOutputTokens: cap });
  });

  it("keeps the ceiling at 16,000", () => {
    expect(PROVIDER_CAP_CEILING).toBe(16_000);
  });

  it("never lets a paced route's cap exceed the output slot it booked", async () => {
    const { gateway, groq } = setup(['{"n": 1}', '{"n": 2}']);
    await gateway.generate({ ...ocr, images: [PNG], maxOutputTokens: 500 });
    await gateway.generate({ ...ocr, images: [PNG] });
    expect(groq.calls.map((call) => call.options?.maxOutputTokens)).toEqual([500, 900]);
  });

  it.each([
    ["three times a small reservation", 500, 1_500],
    ["the route's cap when the reservation is clamped to it", 3_500, 2_000],
  ])("sends a capped unpaced route %s", async (_label, reserved, cap) => {
    const groq = createFakeProvider("groq", ['{"n": 1}']);
    const gateway = createGateway({
      routing: {
        propose_structure: [
          {
            provider: "groq",
            model: "text",
            allowedDataClasses: ["C2"],
            maxOutputTokens: 2_000,
          },
        ],
      },
      providers: { groq },
      budget: new TokenBudget({ perMinute: 100_000, perDay: 1_000_000 }),
    });
    await gateway.generate({
      ...ocr,
      task: "propose_structure",
      maxOutputTokens: reserved,
    });
    expect(groq.calls[0].options?.maxOutputTokens).toBe(cap);
  });

  it("still books only the reservation before the call", async () => {
    const { gateway, budget, request } = textGateway({ inputTokens: 0, outputTokens: 0 });
    await gateway.generate({ ...request, maxOutputTokens: 700 });
    const booked = budget.estimate("sp") + 700;
    expect(budget.canSpend("text", 100_000 - booked)).toBe(true);
    expect(budget.canSpend("text", 100_000 - booked + 1)).toBe(false);
  });

  it("does not net input slack against an output overrun", async () => {
    // Input estimated at 1,001 but only 1 used; output 1,200 against 700 reserved.
    const { gateway, budget, request } = textGateway({
      inputTokens: 1,
      outputTokens: 1_200,
    });
    await gateway.generate({
      ...request,
      prompt: "x".repeat(3_500),
      maxOutputTokens: 700,
    });
    const booked = 1_001 + 700 + 500;
    expect(budget.canSpend("text", 100_000 - booked)).toBe(true);
    expect(budget.canSpend("text", 100_000 - booked + 1)).toBe(false);
  });

  it("records input beyond its estimate on its own", async () => {
    // Input estimated at 1 but 400 used; output under its reservation.
    const { gateway, budget, request } = textGateway({
      inputTokens: 400,
      outputTokens: 0,
    });
    await gateway.generate({ ...request, maxOutputTokens: 700 });
    const booked = 1 + 700 + 399;
    expect(budget.canSpend("text", 100_000 - booked)).toBe(true);
    expect(budget.canSpend("text", 100_000 - booked + 1)).toBe(false);
  });

  it("records the actual usage beyond the reservation after the call", async () => {
    // 2,000 output tokens actually used against 700 reserved.
    const { gateway, budget, request } = textGateway({
      inputTokens: 1,
      outputTokens: 2_000,
    });
    await gateway.generate({ ...request, maxOutputTokens: 700 });
    expect(budget.canSpend("text", 100_000 - 2_001)).toBe(true);
    expect(budget.canSpend("text", 100_000 - 2_000)).toBe(false);
  });

  it("records output beyond the booked slot on a paced route", async () => {
    let now = 1_000_000;
    const groq = createFakeProvider("groq", ['{"n": 1}'], {
      inputTokens: 1,
      outputTokens: 900,
    });
    const budget = new TokenBudget({ perMinute: 100_000, perDay: 1_000_000 }, () => now);
    const gateway = createGateway({ routing, providers: { groq }, budget });
    await gateway.generate({ ...ocr, images: [PNG], maxOutputTokens: 500 });
    // 900 output were produced: another 100 fit in the minute, 101 do not.
    expect(budget.outputWaitMs("vision", 100, 1000)).toBe(0);
    expect(budget.outputWaitMs("vision", 101, 1000)).toBeGreaterThan(0);
    now += 60_000;
    expect(budget.outputWaitMs("vision", 1000, 1000)).toBe(0);
  });
});

describe("gateway output tokens per minute", () => {
  it("waits for the minute window when the next call fits within 70 seconds", async () => {
    const { gateway, groq, sleeps } = setup(['{"a": 1}', '{"b": 2}']);
    await gateway.generate({ ...ocr, images: [PNG] });
    await gateway.generate({ ...ocr, images: [PNG] });
    expect(groq.calls).toHaveLength(2);
    expect(sleeps).toEqual([60_000]);
  });

  it("waits before the repair attempt too", async () => {
    const { gateway, groq, sleeps } = setup(["not json", '{"md": "x"}']);
    await gateway.generate({ ...ocr, images: [PNG] });
    expect(groq.calls).toHaveLength(2);
    expect(sleeps).toEqual([60_000]);
  });

  it.each([
    ["no output cap", undefined],
    ["an output cap above the limit", 1001],
  ])("refuses a routing table whose paced route has %s", (_label, maxOutputTokens) => {
    const route = {
      provider: "groq",
      model: "vision",
      allowedDataClasses: ["C2"],
      vision: true,
      otpm: 1000,
      maxOutputTokens,
    };
    expect(() =>
      createGateway({
        routing: { ocr_page: [route] } as unknown as RoutingConfig,
        providers: {},
        budget: new TokenBudget({ perMinute: 1, perDay: 1 }),
      }),
    ).toThrow(/maxOutputTokens/);
  });

  it("never lets two concurrent calls into the same minute", async () => {
    const { gateway, groq, budget, sleeps } = setup(['{"a": 1}', '{"b": 2}']);
    budget.seedOutput("vision", [{ at: 1_000_000 - 10_000, tokens: 900 }]);
    const results = await Promise.allSettled([
      gateway.generate({ ...ocr, images: [PNG] }),
      gateway.generate({ ...ocr, images: [PNG] }),
    ]);
    // The first books its slot (+50 s) before sleeping; the second would need 110 s and defers.
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(AiQuotaError);
    expect(groq.calls).toHaveLength(1);
    expect(sleeps).toEqual([50_000]);
  });

  it("defers instead of waiting past the caller's deadline", async () => {
    const { gateway, groq, sleeps } = setup(['{"a": 1}', '{"b": 2}']);
    await gateway.generate({ ...ocr, images: [PNG] });
    await expect(
      gateway.generate({ ...ocr, images: [PNG], deadline: 1_000_000 + 59_999 }),
    ).rejects.toBeInstanceOf(AiQuotaError);
    expect(groq.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    await gateway.generate({ ...ocr, images: [PNG], deadline: 1_000_000 + 60_000 });
    expect(sleeps).toEqual([60_000]);
  });

  it("defers the repair instead of waiting past the deadline", async () => {
    const { gateway, groq, sleeps } = setup(["not json", '{"md": "x"}']);
    await expect(
      gateway.generate({ ...ocr, images: [PNG], deadline: 1_000_000 + 30_000 }),
    ).rejects.toBeInstanceOf(AiQuotaError);
    expect(groq.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("defers when the wait would exceed 70 seconds", async () => {
    const { gateway, groq, budget, sleeps } = setup(['{"n": 1}']);
    budget.seedOutput("vision", [
      { at: 1_000_000, tokens: 100 },
      { at: 1_000_000 + 15_000, tokens: 800 },
    ]);
    await expect(gateway.generate({ ...ocr, images: [PNG] })).rejects.toBeInstanceOf(
      AiQuotaError,
    );
    expect(groq.calls).toHaveLength(0);
    expect(sleeps).toEqual([]);
  });
});

describe("gateway privacy for C2 tasks", () => {
  it("skips a route without C2 and uses the one that allows it", async () => {
    const { gateway, groq, gemini } = setup(['{"n": 2}']);
    const result = await gateway.generate({ ...ocr, task: "solve_problem" });
    expect(result.provider).toBe("groq");
    expect(gemini.calls).toHaveLength(0);
    expect(groq.calls).toHaveLength(1);
  });

  it("never calls a provider without C2, even when it is the only route", async () => {
    const { gateway, groq, gemini } = setup(['{"n": 2}']);
    await expect(
      gateway.generate({ ...ocr, task: "alternative_method" }),
    ).rejects.toMatchObject({ code: "no_eligible_route" });
    expect(gemini.calls).toHaveLength(0);
    expect(groq.calls).toHaveLength(0);
  });

  it("treats a task missing from the routing table as having no route", async () => {
    const { gateway } = setup(['{"n": 2}']);
    await expect(
      gateway.generate({ ...ocr, task: "generate_questions" }),
    ).rejects.toMatchObject({ code: "no_eligible_route" });
  });
});

describe("defaultRouting for materials and the solver", () => {
  it("has at least one route for every task", () => {
    for (const task of AI_TASKS) {
      expect(defaultRouting[task].length, task).toBeGreaterThan(0);
    }
  });

  it("sends page images to the vision model, paced at 1,000 output tokens a minute", () => {
    expect(defaultRouting.ocr_page).toEqual([
      {
        provider: "groq",
        model: "qwen/qwen3.8-27b",
        allowedDataClasses: ["C1", "C2"],
        vision: true,
        otpm: 1000,
        maxOutputTokens: 900,
      },
    ]);
  });

  it("routes the material and solver tasks (C2) only to Groq", () => {
    for (const task of [
      "ocr_page",
      "propose_structure",
      "solve_problem",
      "alternative_method",
    ] as const) {
      const routes = defaultRouting[task];
      expect(
        routes.some((route) => route.allowedDataClasses.includes("C2")),
        task,
      ).toBe(true);
      for (const route of routes) {
        if (route.allowedDataClasses.includes("C2")) expect(route.provider).toBe("groq");
      }
    }
  });

  it("caps every paced route's output at or below its per-minute limit", () => {
    for (const task of AI_TASKS) {
      for (const route of defaultRouting[task]) {
        if (route.otpm === undefined) continue;
        expect(route.maxOutputTokens, task).toBeDefined();
        expect(route.maxOutputTokens, task).toBeLessThanOrEqual(route.otpm);
      }
    }
  });

  it("routes an alternative method exactly like a solve", () => {
    expect(defaultRouting.alternative_method).toEqual(defaultRouting.solve_problem);
  });
});
