import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeProvider,
  createGateway,
  defaultRouting,
  type TokenBudget,
} from "@/lib/ai";
import { aiCalls, jobs, solverSessions } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createMemoryStore, type MemoryStore } from "@/lib/storage/memory";
import type { Gateway } from "@/features/generation";
import { EXTRACT_PROBLEM_JOB, SOLVE_PROBLEM_JOB } from "../schema/solver";
import { claimJob, contextFor, htmlBytes, makePhoto, seedSession } from "../test-support";
import { createExtractProblemHandler } from "./extract";
import { photoKey } from "./keys";
import type { SolverDb } from "./quota";

let database: TestDatabase;
let store: MemoryStore;
const db = () => database.db as unknown as SolverDb;
const NOW = new Date("2026-11-20T03:00:00.000Z");
const VISION = defaultRouting.ocr_page[0].model;

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  // Failure logs carry codes only; keep the test output quiet.
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  await database.db.execute(
    sql`truncate ai_calls, jobs, solver_sessions restart identity cascade`,
  );
  store = createMemoryStore();
});

function fakeVision(markdowns: string[]) {
  const provider = createFakeProvider(
    "groq",
    markdowns.map((markdown) => JSON.stringify({ markdown, note: "abaikan" })),
  );
  return {
    provider,
    createGateway: (budget: TokenBudget): Gateway =>
      createGateway({ routing: defaultRouting, providers: { groq: provider }, budget }),
  };
}

/** A clock that moves forward when the budget sleeps. */
function fakeClock(start = NOW) {
  let at = start.getTime();
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => new Date(at),
    sleep: (ms: number) => {
      sleeps.push(ms);
      at += ms;
      return Promise.resolve();
    },
  };
}

async function photoSession(ownerId = USER_A, bytes = makePhoto("jpeg")) {
  const id = await seedSession(db(), {
    ownerId,
    inputKind: "photo",
    status: "extracting",
    confirmedMd: null,
  });
  const key = photoKey(ownerId, id, "jpg");
  await store.put(key, bytes, "image/jpeg");
  await database.db
    .update(solverSessions)
    .set({ inputKey: key })
    .where(eq(solverSessions.id, id));
  return id;
}

async function run(ownerId: string, sessionId: string, markdowns: string[]) {
  const fake = fakeVision(markdowns);
  const clock = fakeClock();
  const job = await claimJob(db(), {
    ownerId,
    type: EXTRACT_PROBLEM_JOB,
    payload: { sessionId },
  });
  const outcome = createExtractProblemHandler({
    db: db(),
    store,
    createGateway: fake.createGateway,
    now: clock.now,
    sleep: clock.sleep,
  })(contextFor(job, NOW.getTime() + 240_000));
  return { fake, clock, outcome };
}

const sessionOf = async (id: string) =>
  (await database.db.select().from(solverSessions).where(eq(solverSessions.id, id)))[0];
const solveJobs = () =>
  database.db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(eq(jobs.type, SOLVE_PROBLEM_JOB));

describe("extract_problem", () => {
  it("reads a clear photo with the vision model (C2) and queues the solve, not counted again", async () => {
    const id = await photoSession();
    const { fake, outcome } = await run(USER_A, id, [
      "Hitung $\\frac{1}{2} + \\frac{1}{4}$.",
    ]);
    expect((await outcome).kind).toBe("done");
    expect(fake.provider.calls).toHaveLength(1);
    const call = fake.provider.calls[0];
    expect(call.model).toBe(VISION);
    expect(call.options?.images?.[0].mime).toBe("image/jpeg");
    expect(call.options?.maxOutputTokens).toBe(900);
    expect(call.system).toMatch(/\[\[\?\]\]/);
    expect(await sessionOf(id)).toMatchObject({
      status: "ready",
      extractedMd: "Hitung $\\frac{1}{2} + \\frac{1}{4}$.",
      confirmedMd: "Hitung $\\frac{1}{2} + \\frac{1}{4}$.",
      extractionFlags: [],
    });
    expect(await solveJobs()).toEqual([
      { payload: { sessionId: id, after: 0, counted: false } },
    ]);
    const [booked] = await database.db.select().from(aiCalls);
    expect(booked).toMatchObject({
      task: "ocr_page",
      model: VISION,
      promptVersion: "extract-problem.id@1",
      outcome: "ok",
    });
  });

  it.each([
    ["an unsure part", "Hitung [[?]]$\\frac{3}{4}$[[?]] dari 20.", ["uncertain"]],
    ["a formula KaTeX cannot read", "Hitung $\\frac{3}{$ dari 20.", ["katex"]],
    ["no text", "   ", ["empty"]],
  ])(
    "holds the reading for the teacher's confirmation on %s (SOL-02)",
    async (_, md, flags) => {
      const id = await photoSession();
      const { outcome } = await run(USER_A, id, [md]);
      await outcome;
      expect(await sessionOf(id)).toMatchObject({
        status: "needs_confirmation",
        confirmedMd: null,
        extractionFlags: flags,
      });
      expect(await solveJobs()).toEqual([]);
    },
  );

  it("paces the vision model like OCR: a call in the last minute makes this one wait", async () => {
    await database.db.insert(aiCalls).values({
      ownerId: USER_B,
      task: "ocr_page",
      provider: "groq",
      model: VISION,
      promptVersion: "ocr-page.id@1",
      inputTokens: 2_400,
      outputTokens: 900,
      outcome: "ok",
      createdAt: new Date(NOW.getTime() - 10_000),
    });
    const id = await photoSession();
    const { clock, outcome } = await run(USER_A, id, ["Hitung 2 + 2."]);
    await outcome;
    expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(50_000);
    expect((await sessionOf(id)).status).toBe("ready");
  });

  it("fails the session without a model call when the photo is not a usable image", async () => {
    const id = await photoSession(USER_A, htmlBytes());
    const { fake, outcome } = await run(USER_A, id, ["x"]);
    expect(await outcome).toMatchObject({ kind: "done" });
    expect(fake.provider.calls).toHaveLength(0);
    expect((await sessionOf(id)).status).toBe("failed");
  });

  it("does nothing for a trashed session, a session already read or another teacher's", async () => {
    const trashed = await photoSession();
    await database.db
      .update(solverSessions)
      .set({ deletedAt: NOW })
      .where(eq(solverSessions.id, trashed));
    const first = await run(USER_A, trashed, ["x"]);
    expect(await first.outcome).toMatchObject({
      kind: "done",
      progress: { step: "skipped" },
    });
    expect(first.fake.provider.calls).toHaveLength(0);

    const read = await photoSession();
    const once = await run(USER_A, read, ["Hitung 2 + 2."]);
    await once.outcome;
    await database.db.execute(sql`truncate jobs restart identity cascade`);
    const twice = await run(USER_A, read, ["Hitung 3 + 3."]);
    expect(await twice.outcome).toMatchObject({
      kind: "done",
      progress: { step: "skipped" },
    });
    expect(twice.fake.provider.calls).toHaveLength(0);

    const foreign = await photoSession();
    const other = await run(USER_B, foreign, ["x"]);
    await expect(other.outcome).rejects.toMatchObject({ code: "extract_not_found" });
    expect(other.fake.provider.calls).toHaveLength(0);
    expect((await sessionOf(foreign)).status).toBe("extracting");
  });
});

describe("the teacher's share of the vision model (R28)", () => {
  it("defers a photo read once the teacher used a quarter of the model's day", async () => {
    for (let i = 0; i < 16; i += 1) {
      await database.db.insert(aiCalls).values({
        ownerId: USER_A,
        task: "ocr_page",
        provider: "groq",
        model: VISION,
        promptVersion: "ocr-page.id@1",
        inputTokens: 2_225,
        outputTokens: 900,
        outcome: "ok",
        createdAt: new Date(NOW.getTime() - 3_600_000 - i * 120_000),
      });
    }
    const id = await photoSession();
    const { fake, outcome } = await run(USER_A, id, ["Hitung 2 + 2."]);
    expect((await outcome).kind).toBe("defer");
    expect(fake.provider.calls).toHaveLength(0);
  });
});
