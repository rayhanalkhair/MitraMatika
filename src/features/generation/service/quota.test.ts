import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aiCalls } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  type TestDatabase,
} from "@/lib/db/test-harness";
import {
  createGenerationBudget,
  createModelBudget,
  CROSS_CHECK_ESTIMATE_TOKENS,
  CROSS_CHECK_MAX_OUTPUT_TOKENS,
  estimateBatchTokens,
  GENERATE_QUOTA,
  jakartaDayWindow,
  planQuota,
  readRecentSpends,
  SOLVE_QUOTA,
  TOKENS_PER_QUESTION,
} from "./quota";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-11T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("estimateBatchTokens", () => {
  it("is linear in the quantity and 8 000 for the default 5", () => {
    expect(TOKENS_PER_QUESTION).toBe(1_600);
    expect(estimateBatchTokens(5)).toBe(8_000);
    expect(estimateBatchTokens(1)).toBe(1_600);
  });
});

describe("GENERATE_QUOTA", () => {
  it("uses the primary generate_questions model and the Groq free daily limit", () => {
    expect(GENERATE_QUOTA.model).toBe("openai/gpt-oss-120b");
    expect(GENERATE_QUOTA.perDay).toBe(200_000);
  });
});

describe("planQuota", () => {
  const plan = (
    spends: { at: Date; tokens: number }[],
    estimate = 8_000,
    perDay = 200_000,
  ) => planQuota({ spends, estimate, perDay, now: NOW });

  it("is ok with no spend", () => {
    expect(plan([])).toEqual({ ok: true });
  });

  it("is ok when the batch exactly fits", () => {
    expect(plan([{ at: ago(HOUR), tokens: 192_000 }])).toEqual({ ok: true });
  });

  it("defers when it does not fit, resuming when enough spend has aged out", () => {
    // 195k used; an 8k batch needs used <= 192k, so the oldest 5k+ spend must age out.
    const result = plan([
      { at: ago(20 * HOUR), tokens: 10_000 },
      { at: ago(5 * HOUR), tokens: 185_000 },
    ]);
    expect(result).toEqual({
      ok: false,
      error: { resumeAt: new Date(ago(20 * HOUR).getTime() + DAY) },
    });
  });

  it("walks forward through several spends until the batch fits", () => {
    const result = plan(
      [
        { at: ago(23 * HOUR), tokens: 1_000 },
        { at: ago(22 * HOUR), tokens: 1_000 },
        { at: ago(21 * HOUR), tokens: 195_000 },
      ],
      8_000,
    );
    // 197k used; removing 1k -> 196k, 1k -> 195k, then 195k -> 0 fits at the third spend.
    expect(result).toEqual({
      ok: false,
      error: { resumeAt: new Date(ago(21 * HOUR).getTime() + DAY) },
    });
  });

  it("ignores spends older than 24 hours", () => {
    expect(plan([{ at: ago(DAY + 1), tokens: 200_000 }])).toEqual({ ok: true });
  });

  it("excludes a spend exactly 24 hours old (the window is open at its far end)", () => {
    expect(plan([{ at: ago(DAY), tokens: 200_000 }])).toEqual({ ok: true });
  });

  it("does not depend on the order of the spends", () => {
    const spends = [
      { at: ago(5 * HOUR), tokens: 185_000 },
      { at: ago(20 * HOUR), tokens: 10_000 },
      { at: ago(22 * HOUR), tokens: 1_000 },
    ];
    // 196k used; the oldest 1k aging out leaves 195k, which is still over 192k, so the 20 h spend decides.
    const sorted = [...spends].sort((a, b) => a.at.getTime() - b.at.getTime());
    const result = plan(spends);
    expect(result).toEqual(plan(sorted));
    expect(result).toEqual(plan([...sorted].reverse()));
    expect(result).toEqual({
      ok: false,
      error: { resumeAt: new Date(ago(20 * HOUR).getTime() + DAY) },
    });
  });

  it("never promises an unreachable resume time when one batch exceeds the whole day", () => {
    expect(plan([{ at: ago(HOUR), tokens: 1_000 }], 250_000)).toEqual({ ok: true });
  });
});

describe("readRecentSpends", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, DB_TEST_TIMEOUT);

  afterAll(async () => {
    await database.client.close();
  });

  beforeEach(async () => {
    await database.db.delete(aiCalls);
  });

  const insert = (
    model: string,
    createdAt: Date,
    input: number | null,
    output: number | null,
  ) =>
    database.db.insert(aiCalls).values({
      ownerId: USER_A,
      task: "generate_questions",
      provider: "groq",
      model,
      promptVersion: "v1",
      outcome: "ok",
      inputTokens: input,
      outputTokens: output,
      createdAt,
    });

  it("returns only the model's calls of the last 24 hours with input + output tokens", async () => {
    await insert("openai/gpt-oss-120b", ago(HOUR), 2_000, 3_000);
    await insert("openai/gpt-oss-120b", ago(2 * HOUR), 1_000, null);
    await insert("openai/gpt-oss-20b", ago(HOUR), 9_000, 9_000);
    await insert("openai/gpt-oss-120b", ago(DAY + HOUR), 5_000, 5_000);
    const spends = await readRecentSpends(database.db, "openai/gpt-oss-120b", NOW);
    expect(spends.map((s) => s.tokens).sort((a, b) => a - b)).toEqual([1_000, 5_000]);
    expect(spends.every((s) => s.at instanceof Date)).toBe(true);
  });

  it("excludes a call created exactly 24 hours ago", async () => {
    await insert("openai/gpt-oss-120b", ago(DAY), 5_000, 5_000);
    await insert("openai/gpt-oss-120b", ago(DAY - 1_000), 1_000, 0);
    const spends = await readRecentSpends(database.db, "openai/gpt-oss-120b", NOW);
    expect(spends.map((s) => s.tokens)).toEqual([1_000]);
  });

  it("counts null token columns as zero", async () => {
    await insert("openai/gpt-oss-120b", ago(HOUR), null, null);
    const spends = await readRecentSpends(database.db, "openai/gpt-oss-120b", NOW);
    expect(spends).toEqual([{ at: ago(HOUR), tokens: 0 }]);
  });
});

describe("createGenerationBudget", () => {
  // The budget uses the real clock, so spends are seeded relative to Date.now().
  it("sees spend of the last minute through the per-minute limit", () => {
    const budget = createGenerationBudget([
      { at: new Date(Date.now() - 30_000), tokens: 7_500 },
    ]);
    expect(budget.canSpend(GENERATE_QUOTA.model, 1_000)).toBe(false);
    expect(budget.canSpend(GENERATE_QUOTA.model, 500)).toBe(true);
  });

  it("ignores spend that is older than a day", () => {
    const budget = createGenerationBudget([
      { at: new Date(Date.now() - 2 * 86_400_000), tokens: 199_000 },
    ]);
    expect(budget.canSpend(GENERATE_QUOTA.model, 8_000)).toBe(true);
  });

  it("applies the daily limit to older spend", () => {
    const budget = createGenerationBudget([
      { at: new Date(Date.now() - 3_600_000), tokens: 199_000 },
    ]);
    expect(budget.canSpend(GENERATE_QUOTA.model, 2_000)).toBe(false);
    expect(budget.canSpend(GENERATE_QUOTA.model, 1_000)).toBe(true);
  });

  it("reads the window from the injected clock", () => {
    const at = new Date("2026-10-11T10:00:00.000Z");
    const spends = [{ at: new Date(at.getTime() - 30_000), tokens: 7_500 }];
    const inside = createGenerationBudget(spends, () => at.getTime());
    expect(inside.canSpend(GENERATE_QUOTA.model, 1_000)).toBe(false);
    const later = createGenerationBudget(spends, () => at.getTime() + 60_000);
    expect(later.canSpend(GENERATE_QUOTA.model, 1_000)).toBe(true);
  });

  it("exposes the per-minute limit next to the daily one", () => {
    expect(GENERATE_QUOTA.perMinute).toBe(8_000);
    expect(GENERATE_QUOTA.perDay).toBe(200_000);
  });
});

describe("SOLVE_QUOTA and createModelBudget", () => {
  it("names the cross-check model with the free-tier limits", () => {
    expect(SOLVE_QUOTA).toEqual({
      model: "openai/gpt-oss-20b",
      perMinute: 8_000,
      perDay: 200_000,
    });
    expect(CROSS_CHECK_ESTIMATE_TOKENS).toBe(2_500);
    expect(CROSS_CHECK_MAX_OUTPUT_TOKENS).toBe(1_200);
  });

  it("seeds the budget of the model it is given", () => {
    const now = 1_000_000_000;
    const budget = createModelBudget(
      SOLVE_QUOTA.model,
      [{ at: new Date(now - 10_000), tokens: 7_500 }],
      () => now,
    );
    expect(budget.canSpend(SOLVE_QUOTA.model, 1_000)).toBe(false);
    expect(budget.canSpend(GENERATE_QUOTA.model, 1_000)).toBe(true);
  });
});

describe("jakartaDayWindow", () => {
  it("starts the day at 00:00 Asia/Jakarta and ends it 24 h later", () => {
    expect(jakartaDayWindow(new Date("2026-11-10T16:59:59.000Z"))).toEqual({
      start: new Date("2026-11-09T17:00:00.000Z"),
      end: new Date("2026-11-10T17:00:00.000Z"),
    });
    expect(jakartaDayWindow(new Date("2026-11-10T17:00:00.000Z"))).toEqual({
      start: new Date("2026-11-10T17:00:00.000Z"),
      end: new Date("2026-11-11T17:00:00.000Z"),
    });
  });
});
