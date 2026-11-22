import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { E2E_FAKE_USER } from "@/features/auth/service/e2e-session";
import {
  aiCalls,
  assessments,
  exports,
  folders,
  generationRequests,
  jobs,
  materialPages,
  materials,
  materialUploads,
  ocrUsage,
  schoolTemplates,
  solverSessions,
  solverSolutions,
} from "@/lib/db/schema";
import { FIXTURE, seedFixtures } from "@/lib/db/test-fixtures";
import {
  questionsRequestedToday,
  USER_DAILY_QUESTION_LIMIT,
} from "@/features/generation";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createJobQueue } from "@/lib/jobs/queue";
import { isFakeAiEnabled } from "@/lib/ai/e2e/control";
import {
  deleteAssessmentData,
  deleteMaterialData,
  deleteSolverData,
  expediteDeferredJobs,
  fillDailyUsage,
  handleControlRequest,
  rewindDailyUsage,
  type ControlRouteDeps,
} from "@/lib/ai/e2e/control-route";
import { logger } from "@/lib/logger";

function makeDeps(overrides: Partial<ControlRouteDeps> = {}) {
  const calls: string[] = [];
  const deps: ControlRouteDeps = {
    enabled: () => true,
    setScenario: (s) => void calls.push(`set:${s}`),
    resetAi: () => void calls.push("reset"),
    expedite: vi.fn(() => {
      calls.push("expedite");
      return Promise.resolve(2);
    }),
    runJobs: vi.fn(() => {
      calls.push("run");
      return Promise.resolve();
    }),
    resetDailyUsage: vi.fn(() => {
      calls.push("resetDailyUsage");
      return Promise.resolve(3);
    }),
    fillDailyUsage: vi.fn(() => {
      calls.push("fillDailyUsage");
      return Promise.resolve();
    }),
    resetAssessments: vi.fn(() => {
      calls.push("resetAssessments");
      return Promise.resolve({ assessments: 2, templates: 1, exportJobs: 3 });
    }),
    resetMaterials: vi.fn(() => {
      calls.push("resetMaterials");
      return Promise.resolve({ materials: 2, folders: 1, uploads: 1, jobs: 4 });
    }),
    resetSolver: vi.fn(() => {
      calls.push("resetSolver");
      return Promise.resolve({ sessions: 3, jobs: 5 });
    }),
    ...overrides,
  };
  return { deps, calls };
}

const post = (body: unknown, raw = false) =>
  new Request("http://localhost/api/e2e/control", {
    method: "POST",
    body: raw ? (body as string) : JSON.stringify(body),
  });

describe("gate", () => {
  it("is a 404 with an empty body when the flag is off, before the body is read", async () => {
    const { deps, calls } = makeDeps({ enabled: () => isFakeAiEnabled({}) });
    const request = post({ reset: true });
    const res = await handleControlRequest(request, deps);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(request.bodyUsed).toBe(false);
    expect(calls).toEqual([]);
  });

  it("is a 404 in production even with the flag on", async () => {
    const { deps, calls } = makeDeps({
      enabled: () => isFakeAiEnabled({ E2E_FAKE_AI: "1", NODE_ENV: "production" }),
    });
    const res = await handleControlRequest(post({ expedite: true }), deps);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(calls).toEqual([]);
  });

  it("is a 404 for other methods too when the gate is off", async () => {
    const { deps } = makeDeps({ enabled: () => false });
    const res = await handleControlRequest(
      new Request("http://localhost/api/e2e/control"),
      deps,
    );
    expect(res.status).toBe(404);
  });
});

describe("validation", () => {
  it("rejects a method other than POST with 405", async () => {
    const { deps } = makeDeps();
    const res = await handleControlRequest(
      new Request("http://localhost/api/e2e/control", { method: "GET" }),
      deps,
    );
    expect(res.status).toBe(405);
  });

  it.each([
    ["non-JSON", "not json", true],
    ["unknown scenario", { scenario: "nope" }, false],
    ["non-string scenario", { scenario: 3 }, false],
    ["empty object", {}, false],
    ["multiple keys", { scenario: "valid", reset: true }, false],
    ["array", [], false],
    ["null", null, false],
    ["reset false", { reset: false }, false],
    ["resetDailyUsage false", { resetDailyUsage: false }, false],
    ["fillDailyUsage not true", { fillDailyUsage: "yes" }, false],
    ["resetAssessments not true", { resetAssessments: 1 }, false],
    ["resetMaterials not true", { resetMaterials: "yes" }, false],
    ["resetSolver false", { resetSolver: false }, false],
    ["unknown key", { other: true }, false],
  ])("answers 400 for %s", async (_name, body, raw) => {
    const { deps, calls } = makeDeps();
    const res = await handleControlRequest(post(body, raw), deps);
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(calls).toEqual([]);
  });
});

describe("actions", () => {
  it("resets the counters before setting a scenario", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleControlRequest(post({ scenario: "rate_limited" }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(calls).toEqual(["reset", "set:rate_limited"]);
  });

  it("resets to the default scenario", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleControlRequest(post({ reset: true }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual(["reset"]);
  });

  it("expedites, runs the jobs once and returns the count", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleControlRequest(post({ expedite: true }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, resumed: 2 });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(calls).toEqual(["expedite", "run"]);
    expect(deps.runJobs).toHaveBeenCalledTimes(1);
  });

  it("answers 500 without leaking details when expedite fails", async () => {
    const { deps } = makeDeps({
      expedite: () => {
        return Promise.reject(new Error("secret detail"));
      },
    });
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const res = await handleControlRequest(post({ expedite: true }), deps);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });

  it("rewinds the fake user's daily usage and returns how many requests moved", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleControlRequest(post({ resetDailyUsage: true }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, moved: 3 });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(calls).toEqual(["resetDailyUsage"]);
  });

  it("fills the fake user's daily usage", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleControlRequest(post({ fillDailyUsage: true }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual(["fillDailyUsage"]);
  });

  it("deletes the fake user's assessment data and returns the counts", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleControlRequest(post({ resetAssessments: true }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      assessments: 2,
      templates: 1,
      exportJobs: 3,
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(calls).toEqual(["resetAssessments"]);
  });

  it("answers 500 without leaking details when the assessment reset fails", async () => {
    const { deps } = makeDeps({
      resetAssessments: () => Promise.reject(new Error("secret detail")),
    });
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const res = await handleControlRequest(post({ resetAssessments: true }), deps);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ module: "e2e-control" }),
      "e2e control: assessment reset failed",
    );
  });

  it("deletes the fake user's materials and solver sessions and returns the counts", async () => {
    const { deps, calls } = makeDeps();
    const materialsRes = await handleControlRequest(post({ resetMaterials: true }), deps);
    expect(materialsRes.status).toBe(200);
    expect(await materialsRes.json()).toEqual({
      ok: true,
      materials: 2,
      folders: 1,
      uploads: 1,
      jobs: 4,
    });
    expect(materialsRes.headers.get("Cache-Control")).toBe("no-store");
    const solverRes = await handleControlRequest(post({ resetSolver: true }), deps);
    expect(await solverRes.json()).toEqual({ ok: true, sessions: 3, jobs: 5 });
    expect(calls).toEqual(["resetMaterials", "resetSolver"]);
  });

  it.each([
    ["resetMaterials", "e2e control: materials reset failed"],
    ["resetSolver", "e2e control: solver reset failed"],
  ] as const)(
    "answers 500 without leaking details when %s fails",
    async (key, message) => {
      const { deps } = makeDeps({
        [key]: () => Promise.reject(new Error("secret detail")),
      });
      const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      const res = await handleControlRequest(post({ [key]: true }), deps);
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).not.toContain("secret");
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ module: "e2e-control" }),
        message,
      );
    },
  );

  it("answers 500 without leaking details when the daily usage change fails", async () => {
    const { deps } = makeDeps({
      resetDailyUsage: () => Promise.reject(new Error("secret detail")),
    });
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const res = await handleControlRequest(post({ resetDailyUsage: true }), deps);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});

describe("daily usage seams", () => {
  let database: TestDatabase;
  const FAKE = E2E_FAKE_USER.id;
  const NOW = new Date();

  const insertRequest = (ownerId: string, createdAt: Date) =>
    database.db.insert(generationRequests).values({
      ownerId,
      status: "succeeded",
      params: { topicTitle: "T", quantity: 5, difficulty: "sedang" },
      createdAt,
    });

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.execute(
      sql`insert into "user" (id, name, email) values (${FAKE}, 'Fake teacher', 'teacher@example.test')`,
    );
    await database.db.execute(
      sql`insert into profiles (id, display_name) values (${FAKE}, 'Fake teacher')`,
    );
  }, DB_TEST_TIMEOUT);
  afterAll(async () => {
    await database.client.close();
  });
  beforeEach(async () => {
    await database.db.delete(generationRequests);
  });

  it("moves only the fake user's requests of the last day back one day and keeps the rows", async () => {
    await insertRequest(FAKE, NOW);
    await insertRequest(FAKE, new Date(NOW.getTime() - 60_000));
    const old = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    await insertRequest(FAKE, old);
    await insertRequest(USER_B, NOW);
    expect(await questionsRequestedToday(database.db, FAKE, NOW)).toBe(10);

    const moved = await rewindDailyUsage(database.db, FAKE);

    expect(moved).toBe(2);
    expect(await questionsRequestedToday(database.db, FAKE, NOW)).toBe(0);
    expect(await questionsRequestedToday(database.db, USER_B, NOW)).toBe(5);
    const rows = await database.db
      .select({ createdAt: generationRequests.createdAt })
      .from(generationRequests)
      .where(eq(generationRequests.ownerId, FAKE));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.createdAt.getTime()).sort()).toContain(old.getTime());
  });

  it("moves the fake user's regenerations of the last day back too", async () => {
    await database.db.delete(jobs);
    await database.db.insert(jobs).values([
      { ownerId: FAKE, type: "regenerate_question", createdAt: NOW },
      { ownerId: FAKE, type: "generate_batch", createdAt: NOW },
      { ownerId: USER_B, type: "regenerate_question", createdAt: NOW },
    ]);
    expect(await questionsRequestedToday(database.db, FAKE, NOW)).toBe(1);

    expect(await rewindDailyUsage(database.db, FAKE)).toBe(1);

    expect(await questionsRequestedToday(database.db, FAKE, NOW)).toBe(0);
    expect(await questionsRequestedToday(database.db, USER_B, NOW)).toBe(1);
    const batch = await database.db
      .select({ createdAt: jobs.createdAt })
      .from(jobs)
      .where(eq(jobs.type, "generate_batch"));
    expect(batch[0].createdAt.getTime()).toBe(NOW.getTime());
    await database.db.delete(jobs);
  });

  it("fills the fake user's day up to the daily limit", async () => {
    await insertRequest(FAKE, NOW);
    await fillDailyUsage(database.db, FAKE, USER_DAILY_QUESTION_LIMIT);
    expect(await questionsRequestedToday(database.db, FAKE, new Date())).toBe(
      USER_DAILY_QUESTION_LIMIT,
    );
    expect(await questionsRequestedToday(database.db, USER_B, new Date())).toBe(0);
  });
});

describe("expediteDeferredJobs", () => {
  let database: TestDatabase;
  const FAKE = E2E_FAKE_USER.id;
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.execute(
      sql`insert into "user" (id, name, email) values (${FAKE}, 'Fake teacher', 'teacher@example.test')`,
    );
    await database.db.execute(
      sql`insert into profiles (id, display_name) values (${FAKE}, 'Fake teacher')`,
    );
  }, DB_TEST_TIMEOUT);
  afterAll(async () => {
    await database.client.close();
  });
  beforeEach(async () => {
    await database.db.delete(jobs);
  });

  it("makes only the fake user's deferred jobs due", async () => {
    const queue = createJobQueue(database.db);
    const mine = await queue.enqueue({
      ownerId: FAKE,
      type: "demo",
      status: "deferred",
      runAfter: FUTURE,
    });
    const queuedMine = await queue.enqueue({
      ownerId: FAKE,
      type: "demo",
      runAfter: FUTURE,
    });
    const others = await queue.enqueue({
      ownerId: USER_B,
      type: "demo",
      status: "deferred",
      runAfter: FUTURE,
    });

    const count = await expediteDeferredJobs(database.db, FAKE);

    expect(count).toBe(1);
    const row = async (id: string) =>
      (await database.db.select().from(jobs).where(eq(jobs.id, id)))[0];
    expect((await row(mine.id)).runAfter.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await row(mine.id)).status).toBe("deferred");
    expect((await row(queuedMine.id)).runAfter.getTime()).toBe(FUTURE.getTime());
    expect((await row(others.id)).runAfter.getTime()).toBe(FUTURE.getTime());
  });
});

describe("deleteAssessmentData", () => {
  let database: TestDatabase;
  const FAKE = E2E_FAKE_USER.id;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.execute(
      sql`insert into "user" (id, name, email) values (${FAKE}, 'Fake teacher', 'teacher@example.test')`,
    );
    await database.db.execute(
      sql`insert into profiles (id, display_name) values (${FAKE}, 'Fake teacher')`,
    );
  }, DB_TEST_TIMEOUT);
  afterAll(async () => {
    await database.client.close();
  });

  // A template, an assessment using it (trashed when asked), a finished export job and its ZIP row.
  async function seed(ownerId: string, trashed = false) {
    const [template] = await database.db
      .insert(schoolTemplates)
      .values({ ownerId, name: "Kop", schoolName: "SMP Contoh", isDefault: !trashed })
      .returning({ id: schoolTemplates.id });
    const [assessment] = await database.db
      .insert(assessments)
      .values({
        ownerId,
        title: "Ulangan",
        grade: 8,
        templateId: template.id,
        ...(trashed ? { deletedAt: new Date(), purgeAfter: new Date() } : {}),
      })
      .returning({ id: assessments.id });
    const job = await createJobQueue(database.db).enqueue({
      ownerId,
      type: "render_export",
    });
    await database.db.insert(exports).values({
      ownerId,
      assessmentId: assessment.id,
      document: "zip",
      format: "zip",
      objectKey: `exports/${ownerId}/${job.id}/bundle.zip`,
      snapshotHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      jobId: job.id,
    });
  }

  const count = async (
    table: typeof assessments | typeof schoolTemplates | typeof exports,
    ownerId: string,
  ) => (await database.db.select().from(table).where(eq(table.ownerId, ownerId))).length;

  it("deletes only the fake user's assessments, templates, export rows and export jobs", async () => {
    await seed(FAKE);
    await seed(FAKE, true);
    await seed(USER_B);
    const other = await createJobQueue(database.db).enqueue({
      ownerId: FAKE,
      type: "generate_batch",
    });

    expect(await deleteAssessmentData(database.db, FAKE)).toEqual({
      assessments: 2,
      templates: 2,
      exportJobs: 2,
    });

    for (const table of [assessments, schoolTemplates, exports]) {
      expect(await count(table, FAKE)).toBe(0);
      expect(await count(table, USER_B)).toBe(1);
    }
    const remainingJobs = await database.db
      .select({ id: jobs.id, ownerId: jobs.ownerId })
      .from(jobs);
    expect(remainingJobs.filter((row) => row.ownerId === FAKE)).toEqual([
      { id: other.id, ownerId: FAKE },
    ]);
    expect(remainingJobs.filter((row) => row.ownerId === USER_B)).toHaveLength(1);

    // Nothing left: a second reset is a no-op.
    expect(await deleteAssessmentData(database.db, FAKE)).toEqual({
      assessments: 0,
      templates: 0,
      exportJobs: 0,
    });
  });
});

describe("deleteMaterialData and deleteSolverData", () => {
  let database: TestDatabase;
  const TODAY = new Date();
  const OLD = new Date(TODAY.getTime() - 3 * 24 * 60 * 60 * 1000);
  const MATERIAL_JOBS = ["ingest_material", "ocr_pages", "propose_structure"];
  const SOLVER_JOBS = ["extract_problem", "solve_problem", "alternative_method"];
  const RECENT = TODAY.getTime() - 60_000;

  beforeAll(async () => {
    database = await createTestDatabase();
    // Both users own a folder, a material with a page and a chapter, an upload reservation and a
    // solved session with one solution.
    await seedFixtures(database.db);
  }, DB_TEST_TIMEOUT);
  afterAll(async () => {
    await database.client.close();
  });

  const count = async (
    table:
      | typeof materials
      | typeof materialPages
      | typeof folders
      | typeof materialUploads
      | typeof ocrUsage
      | typeof solverSessions
      | typeof solverSolutions,
    ownerId: string,
  ) => (await database.db.select().from(table).where(eq(table.ownerId, ownerId))).length;
  const job = async (id: string) =>
    (await database.db.select().from(jobs).where(eq(jobs.id, id)))[0];

  it("deletes only that owner's library, keeps cited questions and retires its material jobs", async () => {
    const run = (statement: string) => database.db.execute(sql.raw(statement));
    // A banked question of USER_A citing USER_A's material: it stays, without the link (MAT-11).
    const source = crypto.randomUUID();
    await run(
      `insert into question_sources (id, owner_id, question_version_id, kind, material_id, material_page_id, section_id, anchor_label, excerpt)
       values ('${source}', '${USER_A}', '${FIXTURE.version(1)}', 'material', '${FIXTURE.material(1)}', '${FIXTURE.materialPage(1)}', '${FIXTURE.materialSection(1)}', 'hal. 1', 'Pola bilangan ganjil')`,
    );
    // A second day of USER_A's OCR counts (the fixtures hold one day for each user).
    await database.db
      .insert(ocrUsage)
      .values({ ownerId: USER_A, day: "2026-11-21", pages: 4 });
    const queue = createJobQueue(database.db);
    const queued = await queue.enqueue({ ownerId: USER_A, type: "ocr_pages" });
    const paid = await queue.enqueue({ ownerId: USER_A, type: "propose_structure" });
    // A model call was booked for this job: the job row must stay (ai_calls points at it).
    await database.db.insert(aiCalls).values({
      ownerId: USER_A,
      jobId: paid.id,
      task: "propose_structure",
      provider: "groq",
      model: "m",
      promptVersion: "v",
      outcome: "ok",
    });
    const old = await queue.enqueue({ ownerId: USER_A, type: "ingest_material" });
    await database.db
      .update(jobs)
      .set({ status: "succeeded", createdAt: OLD })
      .where(eq(jobs.id, old.id));
    const other = await queue.enqueue({ ownerId: USER_A, type: "generate_batch" });
    const theirs = await queue.enqueue({ ownerId: USER_B, type: "ocr_pages" });

    expect(await deleteMaterialData(database.db, USER_A, MATERIAL_JOBS)).toEqual({
      materials: 1,
      folders: 1,
      uploads: 1,
      jobs: 2,
    });

    for (const table of [materials, materialPages, folders, materialUploads, ocrUsage]) {
      expect(await count(table, USER_A)).toBe(0);
      expect(await count(table, USER_B)).toBe(1);
    }
    expect(
      (
        await run(
          `select material_id, material_page_id, excerpt, anchor_label from question_sources where id = '${source}'`,
        )
      ).rows,
    ).toEqual([
      {
        material_id: null,
        material_page_id: null,
        excerpt: null,
        anchor_label: "hal. 1",
      },
    ]);
    expect((await job(queued.id)).status).toBe("cancelled");
    expect((await job(queued.id)).createdAt.getTime()).toBeLessThan(RECENT);
    expect((await job(paid.id)).status).toBe("cancelled");
    expect((await job(old.id)).status).toBe("succeeded");
    expect((await job(old.id)).createdAt.getTime()).toBe(OLD.getTime());
    expect((await job(other.id)).status).toBe("queued");
    expect((await job(other.id)).createdAt.getTime()).toBeGreaterThan(RECENT);
    expect((await job(theirs.id)).status).toBe("queued");

    // Nothing left: a second reset is a no-op.
    expect(await deleteMaterialData(database.db, USER_A, MATERIAL_JOBS)).toEqual({
      materials: 0,
      folders: 0,
      uploads: 0,
      jobs: 0,
    });
  });

  it("deletes only that owner's sessions with their solutions and gives back today's solves", async () => {
    const queue = createJobQueue(database.db);
    const solved = await queue.enqueue({ ownerId: USER_A, type: "solve_problem" });
    await database.db
      .update(jobs)
      .set({ status: "succeeded" })
      .where(eq(jobs.id, solved.id));
    const theirs = await queue.enqueue({ ownerId: USER_B, type: "solve_problem" });

    expect(await deleteSolverData(database.db, USER_A, SOLVER_JOBS)).toEqual({
      sessions: 1,
      jobs: 1,
    });

    for (const table of [solverSessions, solverSolutions]) {
      expect(await count(table, USER_A)).toBe(0);
      expect(await count(table, USER_B)).toBe(1);
    }
    expect((await job(solved.id)).status).toBe("succeeded");
    expect((await job(solved.id)).createdAt.getTime()).toBeLessThan(RECENT);
    expect((await job(theirs.id)).createdAt.getTime()).toBeGreaterThan(RECENT);
  });
});
