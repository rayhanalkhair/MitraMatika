import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deletionLog, jobs, solverSessions, solverSolutions } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createJobQueue } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import type { AnyDb } from "@/features/generation";
import { makePhoto, seedSession, seedSolution } from "@/features/solver/test-support";
import { listingStore } from "../db-test-support";
import { purgeOrder, purgeTrashOncePerDay } from "./purge";
import {
  deleteSolverSessionPermanently,
  listTrashedSolverSessions,
  purgeExpiredSolverSessions,
  restoreSolverSession,
  trashSolverSession,
} from "./solver-trash";
import { solverSessionPrefix } from "./storage-keys";

let database: TestDatabase;
const db = () => database.db as unknown as AnyDb;
const NOW = new Date("2026-11-20T03:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const LATER = new Date(NOW.getTime() + 31 * DAY_MS);

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await database.db.execute(
    sql`truncate audit_log, deletion_log, jobs, solver_sessions restart identity cascade`,
  );
});

const sessionRow = async (id: string) =>
  (await database.db.select().from(solverSessions).where(eq(solverSessions.id, id))).at(
    0,
  );

/** A solved photo session with two methods and its stored photo. */
async function seedStored(
  store: ReturnType<typeof listingStore>,
  ownerId: string,
  text = "Hitung 2 + 2.",
) {
  const id = await seedSession(db(), {
    ownerId,
    inputKind: "photo",
    status: "solved",
    confirmedMd: text,
  });
  const key = `${solverSessionPrefix(ownerId, id)}photo.jpg`;
  await store.put(key, makePhoto("jpeg"), "image/jpeg");
  await database.db
    .update(solverSessions)
    .set({ inputKey: key })
    .where(eq(solverSessions.id, id));
  await seedSolution(db(), { ownerId, sessionId: id, method: "Langsung" });
  await seedSolution(db(), {
    ownerId,
    sessionId: id,
    method: "Lain",
    isAlternative: true,
  });
  return { id, key };
}

describe("solver sessions in the trash", () => {
  it("moves a session to the trash for 30 days and cancels its runs that have not started", async () => {
    const store = listingStore();
    const { id } = await seedStored(store, USER_A);
    const queued = await createJobQueue(database.db).enqueue({
      ownerId: USER_A,
      type: "alternative_method",
      payload: { sessionId: id, after: 2, excludeMethods: [] },
    });
    expect(
      await trashSolverSession(db(), { ownerId: USER_B, sessionId: id, now: NOW }),
    ).toEqual({ ok: false, error: "notFound" });
    expect(
      await trashSolverSession(db(), { ownerId: USER_A, sessionId: id, now: NOW }),
    ).toEqual({ ok: true, data: undefined });
    const row = await sessionRow(id);
    expect(row?.deletedAt).toEqual(NOW);
    expect(row?.purgeAfter).toEqual(new Date(NOW.getTime() + 30 * DAY_MS));
    const [job] = await database.db.select().from(jobs).where(eq(jobs.id, queued.id));
    expect(job.status).toBe("cancelled");
    expect(
      await trashSolverSession(db(), { ownerId: USER_A, sessionId: id, now: NOW }),
    ).toEqual({ ok: false, error: "notFound" });
  });

  it("restores a session as it was, only for its owner", async () => {
    const store = listingStore();
    const { id } = await seedStored(store, USER_A);
    expect(await restoreSolverSession(db(), { ownerId: USER_A, sessionId: id })).toEqual({
      ok: false,
      error: "notInTrash",
    });
    await trashSolverSession(db(), { ownerId: USER_A, sessionId: id, now: NOW });
    expect(await restoreSolverSession(db(), { ownerId: USER_B, sessionId: id })).toEqual({
      ok: false,
      error: "notFound",
    });
    expect(await restoreSolverSession(db(), { ownerId: USER_A, sessionId: id })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await sessionRow(id)).toMatchObject({
      deletedAt: null,
      purgeAfter: null,
      status: "solved",
    });
  });

  it("deletes a trashed session for good: its solutions, then its photos", async () => {
    const store = listingStore();
    const { id, key } = await seedStored(store, USER_A);
    const theirs = await seedStored(store, USER_B);
    expect(
      await deleteSolverSessionPermanently(db(), () => store, {
        ownerId: USER_A,
        sessionId: id,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "notInTrash" });
    await trashSolverSession(db(), { ownerId: USER_A, sessionId: id, now: NOW });
    expect(
      await deleteSolverSessionPermanently(db(), () => store, {
        ownerId: USER_B,
        sessionId: id,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "notFound" });
    expect(
      await deleteSolverSessionPermanently(db(), () => store, {
        ownerId: USER_A,
        sessionId: id,
        now: NOW,
      }),
    ).toEqual({ ok: true, data: { solutions: 2, files: 1 } });
    expect(await sessionRow(id)).toBeUndefined();
    expect(
      await database.db
        .select()
        .from(solverSolutions)
        .where(eq(solverSolutions.sessionId, id)),
    ).toEqual([]);
    expect(store.keys()).toEqual([theirs.key]);
    expect(store.keys()).not.toContain(key);
    const [log] = await database.db.select().from(deletionLog);
    expect(log).toMatchObject({
      ownerId: USER_A,
      entity: "solver_session",
      entityId: id,
      counts: { sessions: 1, solutions: 2 },
    });
  });

  it("keeps the rows when the photo cannot be deleted (retried later)", async () => {
    const store = listingStore({ failPrefix: (prefix) => prefix.startsWith("solver/") });
    const { id } = await seedStored(store, USER_A);
    await trashSolverSession(db(), { ownerId: USER_A, sessionId: id, now: NOW });
    await expect(
      deleteSolverSessionPermanently(db(), () => store, {
        ownerId: USER_A,
        sessionId: id,
        now: NOW,
      }),
    ).rejects.toThrow("storage unavailable");
    expect(await sessionRow(id)).toBeDefined();
  });

  it("purges expired sessions one row at a time, isolating a failure and stopping when out of time", async () => {
    const failing = new Set<string>();
    const store = listingStore({
      failPrefix: (prefix) => [...failing].some((id) => prefix.includes(id)),
    });
    const expired = await seedStored(store, USER_A);
    const broken = await seedStored(store, USER_B);
    const fresh = await seedStored(store, USER_A);
    await trashSolverSession(db(), { ownerId: USER_A, sessionId: expired.id, now: NOW });
    await trashSolverSession(db(), { ownerId: USER_B, sessionId: broken.id, now: NOW });
    await trashSolverSession(db(), {
      ownerId: USER_A,
      sessionId: fresh.id,
      now: new Date(LATER.getTime() - 2 * DAY_MS),
    });
    failing.add(broken.id);
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    expect(await purgeExpiredSolverSessions(db(), () => store, LATER)).toEqual({
      purged: 1,
      failed: 1,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("storage unavailable");
    error.mockRestore();
    expect(await sessionRow(expired.id)).toBeUndefined();
    expect(await sessionRow(broken.id)).toBeDefined();
    expect(await sessionRow(fresh.id)).toBeDefined();
    expect(store.keys()).not.toContain(expired.key);
    failing.clear();
    expect(
      await purgeExpiredSolverSessions(db(), () => store, LATER, {
        outOfTime: () => true,
      }),
    ).toEqual({ purged: 0, failed: 0 });
    expect(await sessionRow(broken.id)).toBeDefined();
  });

  it("is part of the daily trash purge", async () => {
    const store = listingStore();
    const { id } = await seedStored(store, USER_A);
    await trashSolverSession(db(), { ownerId: USER_A, sessionId: id, now: NOW });
    const result = await purgeTrashOncePerDay(db(), LATER, () => store);
    expect(result).toEqual({ purged: 1, failed: 0 });
    expect(await sessionRow(id)).toBeUndefined();
  });

  it("lists the owner's trashed sessions, newest first, with what a delete would take", async () => {
    const store = listingStore();
    const first = await seedStored(store, USER_A, "Soal pertama $x$");
    const second = await seedStored(store, USER_A, "Soal kedua");
    const theirs = await seedStored(store, USER_B);
    await trashSolverSession(db(), { ownerId: USER_A, sessionId: first.id, now: NOW });
    await trashSolverSession(db(), {
      ownerId: USER_A,
      sessionId: second.id,
      now: new Date(NOW.getTime() + 1_000),
    });
    await trashSolverSession(db(), { ownerId: USER_B, sessionId: theirs.id, now: NOW });
    const listed = await listTrashedSolverSessions(db(), { ownerId: USER_A, now: NOW });
    expect(listed.map((item) => item.sessionId)).toEqual([second.id, first.id]);
    expect(listed[1]).toMatchObject({
      excerptMd: "Soal pertama $x$",
      solutionCount: 2,
      hasPhoto: true,
      daysLeft: 30,
    });
  });
});

describe("the daily purge's order (final review M7)", () => {
  it("keeps the dependency order and rotates the independent kinds by day", () => {
    const days = ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24"];
    for (const day of days) {
      const order = purgeOrder(day);
      expect(order.slice(0, 3), day).toEqual(["assessments", "templates", "questions"]);
      expect(new Set(order.slice(3)), day).toEqual(
        new Set(["materials", "folders", "solverSessions"]),
      );
      expect(order.indexOf("folders"), day).toBeGreaterThan(order.indexOf("materials"));
    }
    const thirds = days.slice(0, 3).map((day) => purgeOrder(day)[3]);
    expect(new Set(thirds)).toEqual(new Set(["materials", "solverSessions"]));
  });
});

describe("the daily purge's time slices", () => {
  const BUDGET = 60_000;
  /** A fake clock that the purgers move forward (each read costs 100 ms). */
  function fakeClock() {
    let at = 0;
    return {
      read: () => (at += 100),
      spend: (ms: number) => {
        at += ms;
      },
    };
  }
  type Log = Partial<Record<string, { calls: number; rows: number }>>;
  const note = (log: Log, kind: string, rows: number) => {
    log[kind] = {
      calls: (log[kind]?.calls ?? 0) + 1,
      rows: (log[kind]?.rows ?? 0) + rows,
    };
  };
  /** A kind with an endless backlog: each row costs `rowMs`. */
  const backlog =
    (log: Log, kind: string, clock: ReturnType<typeof fakeClock>, rowMs: number) =>
    (outOfTime: () => boolean) => {
      let rows = 0;
      while (!outOfTime() && rows < 10_000) {
        clock.spend(rowMs);
        rows += 1;
      }
      note(log, kind, rows);
      return Promise.resolve({ purged: rows, failed: 0 });
    };
  /** A kind with `pending` rows of 1 s each. */
  const some =
    (log: Log, kind: string, clock: ReturnType<typeof fakeClock>, pending: number) =>
    (outOfTime: () => boolean) => {
      let rows = 0;
      while (rows < pending && !outOfTime()) {
        clock.spend(1_000);
        rows += 1;
      }
      note(log, kind, rows);
      return Promise.resolve({ purged: rows, failed: 0 });
    };
  const run = (
    clock: ReturnType<typeof fakeClock>,
    purgers: Record<string, unknown>,
    onBacklog?: () => void,
  ) =>
    purgeTrashOncePerDay(db(), LATER, () => listingStore(), {
      budgetMs: BUDGET,
      clock: clock.read,
      purgers: purgers,
      onBacklog,
    });

  it("reports a backlog when the run's budget ends with a kind cut short", async () => {
    const clock = fakeClock();
    const log: Log = {};
    const onBacklog = vi.fn();
    await run(
      clock,
      {
        assessments: backlog(log, "assessments", clock, 1_000),
        templates: some(log, "templates", clock, 0),
        questions: some(log, "questions", clock, 0),
        materials: some(log, "materials", clock, 0),
        folders: some(log, "folders", clock, 0),
        solverSessions: some(log, "solverSessions", clock, 0),
      },
      onBacklog,
    );
    expect(onBacklog).toHaveBeenCalledTimes(1);
  });

  it("reports no backlog when every kind finished inside the budget", async () => {
    const clock = fakeClock();
    const log: Log = {};
    const onBacklog = vi.fn();
    await run(
      clock,
      {
        assessments: some(log, "assessments", clock, 3),
        templates: some(log, "templates", clock, 3),
        questions: some(log, "questions", clock, 3),
        materials: some(log, "materials", clock, 3),
        folders: some(log, "folders", clock, 3),
        solverSessions: some(log, "solverSessions", clock, 3),
      },
      onBacklog,
    );
    expect(onBacklog).not.toHaveBeenCalled();
  });

  it("leaves every later kind at least one row after a kind overran its slice", async () => {
    const clock = fakeClock();
    const log: Log = {};
    // One assessment row takes 40 s (one slow store call), far past its slice.
    await run(clock, {
      assessments: backlog(log, "assessments", clock, 40_000),
      templates: some(log, "templates", clock, 5),
      questions: some(log, "questions", clock, 5),
      materials: some(log, "materials", clock, 5),
      folders: some(log, "folders", clock, 5),
      solverSessions: some(log, "solverSessions", clock, 5),
    });
    for (const kind of [
      "templates",
      "questions",
      "materials",
      "folders",
      "solverSessions",
    ]) {
      expect(log[kind]?.rows, kind).toBeGreaterThanOrEqual(1);
    }
  });

  it("stops an assessment backlog at its share so the other kinds get theirs in the same run", async () => {
    const clock = fakeClock();
    const log: Log = {};
    await run(clock, {
      assessments: backlog(log, "assessments", clock, 1_000),
      templates: some(log, "templates", clock, 3),
      questions: some(log, "questions", clock, 3),
      materials: some(log, "materials", clock, 3),
      folders: some(log, "folders", clock, 3),
      solverSessions: some(log, "solverSessions", clock, 3),
    });
    for (const kind of [
      "templates",
      "questions",
      "materials",
      "folders",
      "solverSessions",
    ]) {
      expect(log[kind]?.rows, kind).toBe(3);
    }
  });

  it("gives time the others left unused back to an earlier kind in a second pass", async () => {
    const clock = fakeClock();
    const log: Log = {};
    await run(clock, {
      assessments: backlog(log, "assessments", clock, 1_000),
      templates: some(log, "templates", clock, 0),
      questions: some(log, "questions", clock, 0),
      materials: some(log, "materials", clock, 0),
      folders: some(log, "folders", clock, 0),
      solverSessions: some(log, "solverSessions", clock, 0),
    });
    expect(log.assessments?.calls).toBe(2);
    // Far more than its first share of the minute (10 s): it reclaimed what the others left.
    expect(log.assessments?.rows).toBeGreaterThan(40);
  });

  it("does not retry a row that failed in the first pass before the others (R31)", async () => {
    const clock = fakeClock();
    const seen: string[][] = [];
    await run(clock, {
      // Pass 1: one row fails and the kind is cut short by its share; pass 2 sees that row as
      // already failed.
      assessments: (outOfTime: () => boolean, skip?: Set<string>) => {
        seen.push([...(skip ?? new Set<string>())]);
        skip?.add("failing-row");
        while (!outOfTime()) clock.spend(1_000);
        return Promise.resolve({ purged: 0, failed: 1 });
      },
    });
    expect(seen).toEqual([[], ["failing-row"]]);
  });

  it("skips a row named in the run's failed set (the real purge of solver sessions)", async () => {
    const failing = new Set<string>();
    const store = listingStore({ failPrefix: (prefix) => prefix.startsWith("solver/") });
    const { id } = await seedStored(store, USER_A);
    await trashSolverSession(db(), { ownerId: USER_A, sessionId: id, now: NOW });
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    expect(
      await purgeExpiredSolverSessions(db(), () => store, LATER, { skip: failing }),
    ).toEqual({ purged: 0, failed: 1 });
    expect([...failing]).toEqual([id]);
    expect(
      await purgeExpiredSolverSessions(db(), () => store, LATER, { skip: failing }),
    ).toEqual({ purged: 0, failed: 0 });
    error.mockRestore();
  });
});
