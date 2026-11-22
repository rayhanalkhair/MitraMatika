import { describe, expect, it } from "vitest";
import { TokenBudget } from "./budget";

describe("TokenBudget", () => {
  it("estimates tokens as ceil(length / 3.5)", () => {
    const budget = new TokenBudget({ perMinute: 8000, perDay: 200000 });
    expect(budget.estimate("")).toBe(0);
    expect(budget.estimate("abcd")).toBe(2);
    expect(budget.estimate("a".repeat(7))).toBe(2);
    expect(budget.estimate("a".repeat(35))).toBe(10);
  });

  it("allows spending within the minute limit and blocks beyond it", () => {
    const now = 0;
    const budget = new TokenBudget({ perMinute: 1000, perDay: 100000 }, () => now);
    expect(budget.canSpend("m", 600)).toBe(true);
    budget.record("m", 600);
    expect(budget.canSpend("m", 400)).toBe(true);
    expect(budget.canSpend("m", 401)).toBe(false);
  });

  it("frees the minute window after 60 seconds", () => {
    let now = 0;
    const budget = new TokenBudget({ perMinute: 1000, perDay: 100000 }, () => now);
    budget.record("m", 1000);
    expect(budget.canSpend("m", 1)).toBe(false);
    now = 60_001;
    expect(budget.canSpend("m", 1000)).toBe(true);
  });

  it("enforces the daily limit across minutes", () => {
    let now = 0;
    const budget = new TokenBudget({ perMinute: 1000, perDay: 1500 }, () => now);
    budget.record("m", 1000);
    now = 120_000;
    expect(budget.canSpend("m", 501)).toBe(false);
    expect(budget.canSpend("m", 500)).toBe(true);
  });

  it("tracks each model separately", () => {
    const budget = new TokenBudget({ perMinute: 1000, perDay: 100000 });
    budget.record("a", 1000);
    expect(budget.canSpend("a", 1)).toBe(false);
    expect(budget.canSpend("b", 1000)).toBe(true);
  });
});

describe("TokenBudget.seed", () => {
  it("counts seeded spends inside their windows", () => {
    const now = 1_000_000_000;
    const budget = new TokenBudget({ perMinute: 8000, perDay: 200000 }, () => now);
    budget.seed("m", [
      { at: now - 30_000, tokens: 7_500 }, // inside the minute
      { at: now - 3_600_000, tokens: 100_000 }, // inside the day only
    ]);
    expect(budget.canSpend("m", 1_000)).toBe(false); // minute: 7_500 + 1_000 > 8_000
    expect(budget.canSpend("m", 500)).toBe(true);
  });

  it("ignores seeded spends that have aged out", () => {
    const now = 1_000_000_000;
    const budget = new TokenBudget({ perMinute: 8000, perDay: 200000 }, () => now);
    budget.seed("m", [{ at: now - 86_400_000, tokens: 199_000 }]); // exactly 24 h ago
    expect(budget.canSpend("m", 7_000)).toBe(true); // would exceed the day if the seed counted
  });

  it("keeps models separate", () => {
    const now = 1_000_000_000;
    const budget = new TokenBudget({ perMinute: 8000, perDay: 200000 }, () => now);
    budget.seed("a", [{ at: now - 1000, tokens: 8_000 }]);
    expect(budget.canSpend("b", 8_000)).toBe(true);
  });
});

describe("TokenBudget image estimate", () => {
  it("adds 2,048 tokens per image to the text estimate", () => {
    const budget = new TokenBudget({ perMinute: 8000, perDay: 200000 });
    expect(budget.estimate("a".repeat(35), 0)).toBe(10);
    expect(budget.estimate("a".repeat(35), 1)).toBe(10 + 2048);
    expect(budget.estimate("", 3)).toBe(3 * 2048);
  });
});

describe("TokenBudget.book", () => {
  const START = 1_000_000;
  const PACED = { tokens: 900, otpm: 1000 };

  // The clock moves when a sleep resolves (a microtask later), like a real timer would.
  function paced() {
    let now = START;
    const sleeps: number[] = [];
    const budget = new TokenBudget(
      { perMinute: 100_000, perDay: 1_000_000 },
      () => now,
      (ms) => {
        sleeps.push(ms);
        return Promise.resolve().then(() => {
          now += ms;
        });
      },
    );
    return {
      budget,
      sleeps,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("books the cost and the output at once when the output fits now", async () => {
    const { budget, sleeps } = paced();
    expect(await budget.book("vision", 1000, { output: PACED })).toBe(true);
    expect(sleeps).toEqual([]);
    expect(budget.canSpend("vision", 99_001)).toBe(false);
    expect(budget.outputWaitMs("vision", 900, 1000)).toBe(60_000);
  });

  it("books a plain cost like record when there is no output limit", async () => {
    const { budget } = paced();
    expect(await budget.book("text", 99_000)).toBe(true);
    expect(await budget.book("text", 1_001)).toBe(false);
  });

  it("waits until earlier output leaves the minute window when the wait is short", async () => {
    const { budget, sleeps, advance } = paced();
    expect(await budget.book("vision", 1000, { output: PACED })).toBe(true);
    advance(10_000);
    expect(await budget.book("vision", 1000, { output: PACED })).toBe(true);
    expect(sleeps).toEqual([50_000]);
  });

  it("counts output per model", async () => {
    const { budget, sleeps } = paced();
    await budget.book("vision", 1000, { output: PACED });
    expect(await budget.book("other", 1000, { output: PACED })).toBe(true);
    expect(sleeps).toEqual([]);
  });

  it("refuses without waiting when one request exceeds the limit on its own", async () => {
    const { budget, sleeps } = paced();
    expect(budget.outputWaitMs("vision", 1200, 1000)).toBe(Infinity);
    expect(
      await budget.book("vision", 1000, { output: { tokens: 1200, otpm: 1000 } }),
    ).toBe(false);
    expect(sleeps).toEqual([]);
  });

  it("never needs more than a minute for past spends alone", async () => {
    const { budget, sleeps, advance } = paced();
    await budget.book("vision", 100, { output: { tokens: 100, otpm: 1000 } });
    advance(15_000);
    await budget.book("vision", 800, { output: { tokens: 800, otpm: 1000 } });
    // 900 more fit once both have left the window: the second, 60 s after it was spent.
    expect(budget.outputWaitMs("vision", 900, 1000)).toBe(60_000);
    expect(await budget.book("vision", 900, { output: PACED })).toBe(true);
    expect(sleeps).toEqual([60_000]);
  });

  it("refuses without waiting when a booked slot pushes the wait over 70 seconds", async () => {
    const { budget, sleeps } = paced();
    // A slot booked by a call that is still waiting (dated 50 s ahead).
    budget.seedOutput("vision", [{ at: START + 50_000, tokens: 900 }]);
    expect(budget.outputWaitMs("vision", 900, 1000)).toBe(110_000);
    expect(await budget.book("vision", 900, { output: PACED })).toBe(false);
    expect(sleeps).toEqual([]);
    expect(budget.canSpend("vision", 100_000)).toBe(true);
  });

  it("waits up to exactly 70 seconds", async () => {
    const { budget, sleeps } = paced();
    budget.seedOutput("vision", [{ at: START + 10_000, tokens: 900 }]);
    expect(await budget.book("vision", 1000, { output: PACED })).toBe(true);
    expect(sleeps).toEqual([70_000]);
  });

  it("lets only one of two concurrent bookings into the same minute", async () => {
    const { budget, sleeps } = paced();
    budget.seedOutput("vision", [{ at: START - 10_000, tokens: 900 }]);
    const results = await Promise.all([
      budget.book("vision", 1000, { output: PACED }),
      budget.book("vision", 1000, { output: PACED }),
    ]);
    // The first books its slot (at +50 s) before sleeping; the second would need 110 s.
    expect(results).toEqual([true, false]);
    expect(sleeps).toEqual([50_000]);
  });

  it("releases a booking that no longer fits after the sleep", async () => {
    const { budget, sleeps } = paced();
    budget.seedOutput("vision", [{ at: START - 10_000, tokens: 900 }]);
    const pending = budget.book("vision", 1000, { output: PACED });
    // Another process's spend arrives while this one sleeps.
    budget.seedOutput("vision", [{ at: START + 40_000, tokens: 900 }]);
    expect(await pending).toBe(false);
    expect(sleeps).toEqual([50_000]);
    // Only the seeds remain: the released booking no longer counts.
    expect(budget.canSpend("vision", 100_000)).toBe(true);
  });

  it("never sleeps past the caller's deadline", async () => {
    const { budget, sleeps } = paced();
    budget.seedOutput("vision", [{ at: START - 10_000, tokens: 900 }]);
    expect(
      await budget.book("vision", 1000, { output: PACED, deadline: START + 49_999 }),
    ).toBe(false);
    expect(sleeps).toEqual([]);
    expect(budget.canSpend("vision", 100_000)).toBe(true);
    expect(
      await budget.book("vision", 1000, { output: PACED, deadline: START + 50_000 }),
    ).toBe(true);
    expect(sleeps).toEqual([50_000]);
  });
});
