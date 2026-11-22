import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aiCalls, jobs, ocrUsage, solverSessions } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { contains, jpegWithExif, pngWithMetadata } from "@/lib/images/metadata-fixtures";
import { createMemoryStore, type MemoryStore } from "@/lib/storage/memory";
import {
  ALTERNATIVE_METHOD_JOB,
  EXTRACT_PROBLEM_JOB,
  MAX_METHODS,
  MAX_PENDING_PHOTOS,
  MAX_PROBLEM_CHARS,
  SOLVE_PROBLEM_JOB,
  USER_DAILY_SOLVES,
} from "../schema/solver";
import { htmlBytes, makePhoto, seedSession, seedSolution } from "../test-support";
import { createJobQueue } from "@/lib/jobs/queue";
import { photoKey, photoStagingKey } from "./keys";
import { solvesLeft, type SolverDb } from "./quota";
import {
  confirmExtraction,
  createTextSession,
  finalizePhotoSession,
  getSession,
  listRecentSessions,
  requestAlternative,
  solveAgain,
  startPhotoSession,
} from "./sessions";

let database: TestDatabase;
let store: MemoryStore;
const db = () => database.db as unknown as SolverDb;
// 10:00 in Jakarta.
const NOW = new Date("2026-11-20T03:00:00.000Z");

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await database.db.execute(sql`truncate jobs, solver_sessions restart identity cascade`);
  store = createMemoryStore({ uploadPath: "/api/dev/upload" });
});

async function jobsOf(ownerId: string) {
  return database.db
    .select({ type: jobs.type, payload: jobs.payload })
    .from(jobs)
    .where(eq(jobs.ownerId, ownerId));
}
async function sessionRow(id: string) {
  return (
    await database.db.select().from(solverSessions).where(eq(solverSessions.id, id))
  ).at(0);
}
/** Uses up `n` of the owner's solves today (each one a counted solve job). */
async function spend(ownerId: string, n: number, at = NOW) {
  for (let i = 0; i < n; i += 1) {
    const created = await createTextSession(db(), {
      ownerId,
      text: `${String(i)} + 1`,
      now: at,
    });
    expect(created.ok).toBe(true);
  }
}

describe("createTextSession", () => {
  it("stores the typed problem as confirmed and queues a counted solve", async () => {
    const created = await createTextSession(db(), {
      ownerId: USER_A,
      text: "  Hitung $\\frac{1}{2} + \\frac{1}{4}$.  ",
      now: NOW,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const row = await sessionRow(created.data.sessionId);
    expect(row).toMatchObject({
      ownerId: USER_A,
      inputKind: "text",
      status: "ready",
      confirmedMd: "Hitung $\\frac{1}{2} + \\frac{1}{4}$.",
    });
    expect(await jobsOf(USER_A)).toEqual([
      {
        type: SOLVE_PROBLEM_JOB,
        payload: { sessionId: created.data.sessionId, after: 0, counted: true },
      },
    ]);
    expect(await solvesLeft(db(), { ownerId: USER_A, now: NOW })).toBe(
      USER_DAILY_SOLVES - 1,
    );
  });

  it("refuses an empty or too long problem without counting it", async () => {
    expect(
      await createTextSession(db(), { ownerId: USER_A, text: "  ", now: NOW }),
    ).toEqual({
      ok: false,
      error: "empty",
    });
    expect(
      await createTextSession(db(), {
        ownerId: USER_A,
        text: "x".repeat(MAX_PROBLEM_CHARS + 1),
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "tooLong" });
    expect(await jobsOf(USER_A)).toEqual([]);
  });
});

describe("the daily cap (USER_DAILY_SOLVES per Jakarta day)", () => {
  it("is 30 and refuses the 31st solve of the day, then resets at midnight in Jakarta", async () => {
    expect(USER_DAILY_SOLVES).toBe(30);
    const lastSecond = new Date("2026-11-20T16:59:59.000Z");
    await spend(USER_A, USER_DAILY_SOLVES, new Date("2026-11-19T17:00:00.000Z"));
    expect(
      await createTextSession(db(), { ownerId: USER_A, text: "1+1", now: lastSecond }),
    ).toEqual({ ok: false, error: "limit" });
    expect(await solvesLeft(db(), { ownerId: USER_A, now: lastSecond })).toBe(0);
    // Another teacher's count is their own.
    expect(
      (await createTextSession(db(), { ownerId: USER_B, text: "1+1", now: lastSecond }))
        .ok,
    ).toBe(true);
    const midnight = new Date("2026-11-20T17:00:00.000Z");
    expect(await solvesLeft(db(), { ownerId: USER_A, now: midnight })).toBe(
      USER_DAILY_SOLVES,
    );
    expect(
      (await createTextSession(db(), { ownerId: USER_A, text: "1+1", now: midnight })).ok,
    ).toBe(true);
  });

  it("counts two concurrent requests for the last solve once", async () => {
    await spend(USER_A, USER_DAILY_SOLVES - 1);
    const results = await Promise.all([
      createTextSession(db(), { ownerId: USER_A, text: "a", now: NOW }),
      createTextSession(db(), { ownerId: USER_A, text: "b", now: NOW }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await solvesLeft(db(), { ownerId: USER_A, now: NOW })).toBe(0);
  });

  it("counts every model run: a photo, a solve after a failure and another method", async () => {
    await spend(USER_A, USER_DAILY_SOLVES - 1);
    const failed = await seedSession(db(), {
      ownerId: USER_A,
      status: "failed",
      confirmedMd: "1+1",
    });
    expect(
      (await solveAgain(db(), { ownerId: USER_A, sessionId: failed, now: NOW })).ok,
    ).toBe(true);
    const solved = await seedSession(db(), { ownerId: USER_A, status: "solved" });
    await seedSolution(db(), {
      ownerId: USER_A,
      sessionId: solved,
      method: "Substitusi",
    });
    expect(
      await requestAlternative(db(), { ownerId: USER_A, sessionId: solved, now: NOW }),
    ).toEqual({ ok: false, error: "limit" });
    expect(
      await startPhotoSession(db(), store, {
        ownerId: USER_A,
        kind: "photo",
        mime: "image/jpeg",
        size: 100,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "limit" });
  });
});

describe("photo sessions", () => {
  async function start(ownerId = USER_A, mime: "image/png" | "image/jpeg" = "image/png") {
    const started = await startPhotoSession(db(), store, {
      ownerId,
      kind: "photo",
      mime,
      size: 100,
      now: NOW,
    });
    if (!started.ok) throw new Error(started.error);
    return started.data;
  }

  it("signs a PUT to the session's staging key only, and counts nothing yet", async () => {
    const started = await start();
    const staging = photoStagingKey(USER_A, started.sessionId, "png");
    expect(staging).toBe(`solver/${USER_A}/${started.sessionId}/upload.png`);
    expect(decodeURIComponent(started.uploadUrl)).toContain(staging);
    expect(await sessionRow(started.sessionId)).toMatchObject({
      status: "pending",
      inputKind: "photo",
      inputKey: staging,
    });
    expect(await solvesLeft(db(), { ownerId: USER_A, now: NOW })).toBe(USER_DAILY_SOLVES);
  });

  it("refuses more than MAX_PENDING_PHOTOS unfinished uploads within the hour", async () => {
    for (let i = 0; i < MAX_PENDING_PHOTOS; i += 1) await start();
    expect(
      await startPhotoSession(db(), store, {
        ownerId: USER_A,
        kind: "file",
        mime: "image/png",
        size: 100,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "pending" });
  });

  it("checks the photo, keeps it under a key never signed for a PUT and queues the reading", async () => {
    const started = await start();
    const staging = photoStagingKey(USER_A, started.sessionId, "png");
    await store.put(staging, makePhoto("png"), "image/png");
    const finalized = await finalizePhotoSession(db(), store, {
      ownerId: USER_A,
      sessionId: started.sessionId,
      now: NOW,
    });
    expect(finalized.ok).toBe(true);
    const final = photoKey(USER_A, started.sessionId, "png");
    expect(final).not.toBe(staging);
    expect(await store.get(final)).not.toBeNull();
    expect(await store.get(staging)).toBeNull();
    expect(await sessionRow(started.sessionId)).toMatchObject({
      status: "extracting",
      inputKey: final,
    });
    expect(await jobsOf(USER_A)).toEqual([
      { type: EXTRACT_PROBLEM_JOB, payload: { sessionId: started.sessionId } },
    ]);
    expect(await solvesLeft(db(), { ownerId: USER_A, now: NOW })).toBe(
      USER_DAILY_SOLVES - 1,
    );
    // A second finalise of the same session does nothing.
    expect(
      await finalizePhotoSession(db(), store, {
        ownerId: USER_A,
        sessionId: started.sessionId,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "notFound" });
  });

  it("keeps the photo without its metadata (Exif GPS, XMP, IPTC; PNG text chunks)", async () => {
    for (const [mime, ext, bytes] of [
      ["image/jpeg", "jpg", jpegWithExif()],
      ["image/png", "png", pngWithMetadata()],
    ] as const) {
      const started = await start(USER_A, mime);
      await store.put(photoStagingKey(USER_A, started.sessionId, ext), bytes, mime);
      expect(
        (
          await finalizePhotoSession(db(), store, {
            ownerId: USER_A,
            sessionId: started.sessionId,
            now: NOW,
          })
        ).ok,
      ).toBe(true);
      const kept = await store.get(photoKey(USER_A, started.sessionId, ext));
      expect(kept).not.toBeNull();
      if (!kept) return;
      for (const marker of ["GPS", "Exif", "eXIf", "tEXt", "xmpmeta", "rumah"]) {
        expect(contains(kept, marker), `${ext}: ${marker}`).toBe(false);
      }
      expect(kept.length).toBeLessThan(bytes.length);
    }
  });

  it("refuses bytes that are not the declared image and deletes them", async () => {
    const started = await start(USER_A, "image/jpeg");
    const staging = photoStagingKey(USER_A, started.sessionId, "jpg");
    await store.put(staging, htmlBytes(), "image/jpeg");
    expect(
      await finalizePhotoSession(db(), store, {
        ownerId: USER_A,
        sessionId: started.sessionId,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "type" });
    expect(await store.get(staging)).toBeNull();
    expect(await sessionRow(started.sessionId)).toBeUndefined();
    // A PNG uploaded as a JPEG is refused too.
    const second = await start(USER_A, "image/jpeg");
    await store.put(
      photoStagingKey(USER_A, second.sessionId, "jpg"),
      makePhoto("png"),
      "image/jpeg",
    );
    expect(
      await finalizePhotoSession(db(), store, {
        ownerId: USER_A,
        sessionId: second.sessionId,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "type" });
    expect(await jobsOf(USER_A)).toEqual([]);
  });

  it("refuses an image without a readable size, keeps a missing upload for a retry", async () => {
    const started = await start();
    expect(
      await finalizePhotoSession(db(), store, {
        ownerId: USER_A,
        sessionId: started.sessionId,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "missing" });
    expect(await sessionRow(started.sessionId)).toMatchObject({ status: "pending" });
    const header = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    await store.put(
      photoStagingKey(USER_A, started.sessionId, "png"),
      header,
      "image/png",
    );
    expect(
      await finalizePhotoSession(db(), store, {
        ownerId: USER_A,
        sessionId: started.sessionId,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "image" });
  });

  it("refuses a finalise after the window, and another teacher's session entirely", async () => {
    const started = await start();
    await store.put(
      photoStagingKey(USER_A, started.sessionId, "png"),
      makePhoto("png"),
      "image/png",
    );
    expect(
      await finalizePhotoSession(db(), store, {
        ownerId: USER_B,
        sessionId: started.sessionId,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "notFound" });
    expect(
      await store.get(photoStagingKey(USER_A, started.sessionId, "png")),
    ).not.toBeNull();
    expect(
      await finalizePhotoSession(db(), store, {
        ownerId: USER_A,
        sessionId: started.sessionId,
        now: new Date(NOW.getTime() + 61 * 60_000),
      }),
    ).toEqual({ ok: false, error: "expired" });
    expect(await store.get(photoStagingKey(USER_A, started.sessionId, "png"))).toBeNull();
  });
});

describe("confirmExtraction (SOL-02)", () => {
  it("solves only after the teacher confirms, without counting the solve again", async () => {
    const id = await seedSession(db(), {
      ownerId: USER_A,
      inputKind: "photo",
      status: "needs_confirmation",
      extractedMd: "Hitung [[?]]$\\frac{1}{2}$[[?]].",
      extractionFlags: ["uncertain"],
    });
    // Its reading ran and reached the model: that run counted, the solve is part of it.
    const read = await createJobQueue(database.db).enqueue({
      ownerId: USER_A,
      type: EXTRACT_PROBLEM_JOB,
      payload: { sessionId: id },
      createdAt: NOW,
    });
    await database.db
      .update(jobs)
      .set({ status: "succeeded" })
      .where(eq(jobs.id, read.id));
    await database.db.insert(aiCalls).values({
      ownerId: USER_A,
      jobId: read.id,
      task: "ocr_page",
      provider: "groq",
      model: "qwen/qwen3.8-27b",
      promptVersion: "extract-problem.id@1",
      outcome: "ok",
      createdAt: NOW,
    });
    expect(
      await confirmExtraction(db(), {
        ownerId: USER_A,
        sessionId: id,
        text: "Hitung [[?]]$\\frac{1}{2}$[[?]].",
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "markers" });
    const confirmed = await confirmExtraction(db(), {
      ownerId: USER_A,
      sessionId: id,
      text: " Hitung $\\frac{1}{2}$. ",
      now: NOW,
    });
    expect(confirmed.ok).toBe(true);
    expect(await sessionRow(id)).toMatchObject({
      status: "ready",
      confirmedMd: "Hitung $\\frac{1}{2}$.",
    });
    expect((await jobsOf(USER_A)).at(-1)).toEqual({
      type: SOLVE_PROBLEM_JOB,
      payload: { sessionId: id, after: 0, counted: false },
    });
    // The photo's run is the only one counted.
    expect(await solvesLeft(db(), { ownerId: USER_A, now: NOW })).toBe(
      USER_DAILY_SOLVES - 1,
    );
  });

  it("refuses a session that is not waiting for a confirmation, and another teacher's", async () => {
    const ready = await seedSession(db(), { ownerId: USER_A, status: "ready" });
    expect(
      await confirmExtraction(db(), {
        ownerId: USER_A,
        sessionId: ready,
        text: "1",
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "state" });
    const waiting = await seedSession(db(), {
      ownerId: USER_A,
      inputKind: "photo",
      status: "needs_confirmation",
      extractedMd: "1",
    });
    expect(
      await confirmExtraction(db(), {
        ownerId: USER_B,
        sessionId: waiting,
        text: "1",
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "notFound" });
    expect(await jobsOf(USER_B)).toEqual([]);
  });
});

describe("solveAgain and requestAlternative", () => {
  it("queue another method excluding the labels shown so far", async () => {
    const id = await seedSession(db(), { ownerId: USER_A, status: "solved" });
    await seedSolution(db(), { ownerId: USER_A, sessionId: id, method: "Substitusi" });
    const requested = await requestAlternative(db(), {
      ownerId: USER_A,
      sessionId: id,
      now: NOW,
    });
    expect(requested.ok).toBe(true);
    expect(await jobsOf(USER_A)).toEqual([
      {
        type: ALTERNATIVE_METHOD_JOB,
        payload: { sessionId: id, after: 1, excludeMethods: ["Substitusi"] },
      },
    ]);
    // One at a time.
    expect(
      await requestAlternative(db(), { ownerId: USER_A, sessionId: id, now: NOW }),
    ).toEqual({ ok: false, error: "busy" });
  });

  it("stops after MAX_METHODS methods and refuses unsolved or foreign sessions", async () => {
    const id = await seedSession(db(), { ownerId: USER_A, status: "solved" });
    for (let i = 0; i < MAX_METHODS; i += 1) {
      await seedSolution(db(), {
        ownerId: USER_A,
        sessionId: id,
        method: `Metode ${String(i)}`,
        isAlternative: i > 0,
      });
    }
    expect(
      await requestAlternative(db(), { ownerId: USER_A, sessionId: id, now: NOW }),
    ).toEqual({ ok: false, error: "noMore" });
    expect(
      await requestAlternative(db(), { ownerId: USER_B, sessionId: id, now: NOW }),
    ).toEqual({ ok: false, error: "notFound" });
    const ready = await seedSession(db(), {
      ownerId: USER_A,
      status: "needs_confirmation",
    });
    expect(
      await requestAlternative(db(), { ownerId: USER_A, sessionId: ready, now: NOW }),
    ).toEqual({ ok: false, error: "state" });
    expect(
      await solveAgain(db(), { ownerId: USER_A, sessionId: ready, now: NOW }),
    ).toEqual({
      ok: false,
      error: "state",
    });
  });

  it("solves a failed session again, counted, and refuses a foreign one", async () => {
    const id = await seedSession(db(), {
      ownerId: USER_A,
      status: "failed",
      confirmedMd: "2+2",
    });
    expect(await solveAgain(db(), { ownerId: USER_B, sessionId: id, now: NOW })).toEqual({
      ok: false,
      error: "notFound",
    });
    expect(
      (await solveAgain(db(), { ownerId: USER_A, sessionId: id, now: NOW })).ok,
    ).toBe(true);
    expect(await sessionRow(id)).toMatchObject({ status: "ready" });
    expect(await jobsOf(USER_A)).toEqual([
      { type: SOLVE_PROBLEM_JOB, payload: { sessionId: id, after: 0, counted: true } },
    ]);
  });
});

describe("reads", () => {
  it("lists the owner's newest 20 sessions, without trashed or unfinished uploads", async () => {
    for (let i = 0; i < 22; i += 1) {
      await seedSession(db(), {
        ownerId: USER_A,
        text: `Soal ${String(i)}`,
        createdAt: new Date(NOW.getTime() - (22 - i) * 60_000),
      });
    }
    await seedSession(db(), { ownerId: USER_A, text: "Dibuang", deletedAt: NOW });
    await seedSession(db(), {
      ownerId: USER_A,
      inputKind: "photo",
      status: "pending",
      createdAt: NOW,
    });
    await seedSession(db(), { ownerId: USER_B, text: "Milik B", createdAt: NOW });
    const recent = await listRecentSessions(db(), { ownerId: USER_A });
    expect(recent).toHaveLength(20);
    expect(recent[0].excerptMd).toBe("Soal 21");
    expect(recent.map((item) => item.excerptMd)).not.toContain("Dibuang");
    expect(recent.map((item) => item.excerptMd)).not.toContain("Milik B");
  });

  it("shows a session only to its owner, and a stuck run as failed", async () => {
    const id = await seedSession(db(), { ownerId: USER_A, status: "ready" });
    expect(await getSession(db(), { ownerId: USER_B, sessionId: id })).toBeNull();
    const view = await getSession(db(), { ownerId: USER_A, sessionId: id });
    // No live job behind a `ready` session: the run died, the teacher may solve again.
    expect(view).toMatchObject({ state: "failed", canSolveAgain: true });
    const trashed = await seedSession(db(), { ownerId: USER_A, deletedAt: NOW });
    expect(await getSession(db(), { ownerId: USER_A, sessionId: trashed })).toBeNull();
    expect(
      await database.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.ownerId, USER_B))),
    ).toEqual([]);
  });
});

describe("runs that never reached the model are given back (ruling D1)", () => {
  /** Ends the owner's jobs as `status`, with an ai_calls row for each when `called`. */
  async function finishJobs(ownerId: string, status: string, called: boolean) {
    const rows = await database.db
      .update(jobs)
      .set({ status })
      .where(and(eq(jobs.ownerId, ownerId), eq(jobs.status, "queued")))
      .returning({ id: jobs.id });
    if (!called) return;
    for (const row of rows) {
      await database.db.insert(aiCalls).values({
        ownerId,
        jobId: row.id,
        task: "solve_problem",
        provider: "groq",
        model: "openai/gpt-oss-120b",
        promptVersion: "solve-problem.id@2",
        inputTokens: 10,
        outputTokens: 10,
        outcome: "ok",
        createdAt: NOW,
      });
    }
  }

  it("counts a queued run, keeps counting one that reached the model, and gives back the rest", async () => {
    await spend(USER_A, 3);
    expect(await solvesLeft(db(), { ownerId: USER_A, now: NOW })).toBe(
      USER_DAILY_SOLVES - 3,
    );
    // Cancelled by the trash, or failed before any call: nothing was spent.
    await finishJobs(USER_A, "cancelled", false);
    expect(await solvesLeft(db(), { ownerId: USER_A, now: NOW })).toBe(USER_DAILY_SOLVES);
    await spend(USER_A, 2);
    await database.db
      .update(jobs)
      .set({ status: "failed" })
      .where(and(eq(jobs.ownerId, USER_A), eq(jobs.status, "queued")));
    expect(await solvesLeft(db(), { ownerId: USER_A, now: NOW })).toBe(USER_DAILY_SOLVES);
    // A run that reached the model stays counted, however it ended.
    await spend(USER_A, 1);
    await finishJobs(USER_A, "succeeded", true);
    expect(await solvesLeft(db(), { ownerId: USER_A, now: NOW })).toBe(
      USER_DAILY_SOLVES - 1,
    );
  });

  it("gives back a run that died before its call: only its provisional reservation is left", async () => {
    await spend(USER_A, 1);
    const [job] = await database.db.select().from(jobs).where(eq(jobs.ownerId, USER_A));
    await database.db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, job.id));
    await database.db.insert(aiCalls).values({
      ownerId: USER_A,
      jobId: job.id,
      task: "solve_problem",
      provider: "groq",
      model: "openai/gpt-oss-120b",
      promptVersion: "solve-problem.id@2",
      inputTokens: 2_500,
      outputTokens: 3_000,
      outcome: "error",
      errorCode: "reserved",
      createdAt: NOW,
    });
    expect(await solvesLeft(db(), { ownerId: USER_A, now: NOW })).toBe(USER_DAILY_SOLVES);
  });

  it("counts the solve after a photo whose reading never reached the model", async () => {
    const id = await seedSession(db(), {
      ownerId: USER_A,
      inputKind: "photo",
      status: "failed",
      confirmedMd: null,
    });
    const queue = createJobQueue(database.db);
    const read = await queue.enqueue({
      ownerId: USER_A,
      type: EXTRACT_PROBLEM_JOB,
      payload: { sessionId: id },
      createdAt: NOW,
    });
    await database.db
      .update(jobs)
      .set({ status: "succeeded" })
      .where(eq(jobs.id, read.id));
    expect(await solvesLeft(db(), { ownerId: USER_A, now: NOW })).toBe(USER_DAILY_SOLVES);
    expect(
      (
        await confirmExtraction(db(), {
          ownerId: USER_A,
          sessionId: id,
          text: "1+1",
          now: NOW,
        })
      ).ok,
    ).toBe(true);
    expect((await jobsOf(USER_A)).at(-1)).toEqual({
      type: SOLVE_PROBLEM_JOB,
      payload: { sessionId: id, after: 0, counted: true },
    });
    expect(await solvesLeft(db(), { ownerId: USER_A, now: NOW })).toBe(
      USER_DAILY_SOLVES - 1,
    );
  });

  it("refuses that solve when nothing is left today", async () => {
    await spend(USER_A, USER_DAILY_SOLVES);
    const id = await seedSession(db(), {
      ownerId: USER_A,
      inputKind: "photo",
      status: "failed",
      confirmedMd: null,
    });
    expect(
      await confirmExtraction(db(), {
        ownerId: USER_A,
        sessionId: id,
        text: "1+1",
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "limit" });
  });

  it("counts the solve of a photo read on an earlier day, and refuses it when today is full", async () => {
    const id = await seedSession(db(), {
      ownerId: USER_A,
      inputKind: "photo",
      status: "needs_confirmation",
      extractedMd: "Hitung [[?]]2[[?]] + 2.",
      confirmedMd: null,
    });
    const yesterday = new Date(NOW.getTime() - 24 * 3_600_000);
    const read = await createJobQueue(database.db).enqueue({
      ownerId: USER_A,
      type: EXTRACT_PROBLEM_JOB,
      payload: { sessionId: id },
      createdAt: yesterday,
    });
    await database.db
      .update(jobs)
      .set({ status: "succeeded" })
      .where(eq(jobs.id, read.id));
    await database.db.insert(aiCalls).values({
      ownerId: USER_A,
      jobId: read.id,
      task: "ocr_page",
      provider: "groq",
      model: "qwen/qwen3.8-27b",
      promptVersion: "extract-problem.id@1",
      outcome: "ok",
      createdAt: yesterday,
    });
    await spend(USER_A, USER_DAILY_SOLVES);
    expect(
      await confirmExtraction(db(), {
        ownerId: USER_A,
        sessionId: id,
        text: "Hitung 2 + 2.",
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "limit" });
  });
});

describe("finalize when the cap ran out meanwhile", () => {
  it("keeps no copy of the photo", async () => {
    const started = await startPhotoSession(db(), store, {
      ownerId: USER_A,
      kind: "photo",
      mime: "image/png",
      size: 100,
      now: NOW,
    });
    if (!started.ok) throw new Error(started.error);
    await store.put(
      photoStagingKey(USER_A, started.data.sessionId, "png"),
      makePhoto("png"),
      "image/png",
    );
    await spend(USER_A, USER_DAILY_SOLVES);
    expect(
      await finalizePhotoSession(db(), store, {
        ownerId: USER_A,
        sessionId: started.data.sessionId,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "limit" });
    expect(await store.get(photoKey(USER_A, started.data.sessionId, "png"))).toBeNull();
  });
});

describe("the recent list and a run that died", () => {
  it("shows a session whose run is gone as failed, like its page", async () => {
    const dead = await seedSession(db(), {
      ownerId: USER_A,
      status: "ready",
      text: "Mati",
    });
    const alive = await seedSession(db(), {
      ownerId: USER_A,
      status: "ready",
      text: "Hidup",
    });
    await createJobQueue(database.db).enqueue({
      ownerId: USER_A,
      type: SOLVE_PROBLEM_JOB,
      payload: { sessionId: alive, after: 0, counted: true },
    });
    const recent = await listRecentSessions(db(), { ownerId: USER_A });
    expect(recent.find((item) => item.id === dead)?.status).toBe("failed");
    expect(recent.find((item) => item.id === alive)?.status).toBe("ready");
  });
});

describe("the shared vision cap (R28)", () => {
  it("refuses a photo once OCR pages and photo reads used the 25 vision reads of the day", async () => {
    await database.db.execute(sql`truncate ocr_usage`);
    await database.db.insert(ocrUsage).values({
      ownerId: USER_A,
      day: "2026-11-20",
      pages: 20,
      createdAt: NOW,
      updatedAt: NOW,
    });
    for (let i = 0; i < 5; i += 1) {
      await createJobQueue(database.db).enqueue({
        ownerId: USER_A,
        type: EXTRACT_PROBLEM_JOB,
        payload: { sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` },
        createdAt: NOW,
      });
    }
    expect(
      await startPhotoSession(db(), store, {
        ownerId: USER_A,
        kind: "photo",
        mime: "image/png",
        size: 100,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "visionLimit" });
    // A typed problem is not a vision read.
    expect(
      (await createTextSession(db(), { ownerId: USER_A, text: "1+1", now: NOW })).ok,
    ).toBe(true);
    await database.db.execute(sql`truncate ocr_usage`);
  });
});

describe("photo reads go before OCR pages", () => {
  it("queues the reading of a photo with a priority over bulk work", async () => {
    const started = await startPhotoSession(db(), store, {
      ownerId: USER_A,
      kind: "photo",
      mime: "image/png",
      size: 100,
      now: NOW,
    });
    if (!started.ok) throw new Error(started.error);
    await store.put(
      photoStagingKey(USER_A, started.data.sessionId, "png"),
      makePhoto("png"),
      "image/png",
    );
    const finalized = await finalizePhotoSession(db(), store, {
      ownerId: USER_A,
      sessionId: started.data.sessionId,
      now: NOW,
    });
    expect(finalized.ok).toBe(true);
    const [read] = await database.db
      .select({ priority: jobs.priority })
      .from(jobs)
      .where(eq(jobs.type, EXTRACT_PROBLEM_JOB));
    expect(read.priority).toBeGreaterThan(0);
  });
});
