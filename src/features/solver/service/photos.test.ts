import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { solverSessions } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createMemoryStore, type MemoryStore } from "@/lib/storage/memory";
import { logger } from "@/lib/logger";
import type { ObjectStore } from "@/lib/storage/types";
import { PHOTO_RETENTION_MS } from "../schema/solver";
import { makePhoto, seedSession } from "../test-support";
import { photoKey, photoStagingKey } from "./keys";
import { runSolverHousekeeping, sweepSolverPhotos } from "./photos";
import type { SolverDb } from "./quota";

let database: TestDatabase;
let store: MemoryStore;
const db = () => database.db as unknown as SolverDb;
const STARTED = new Date("2026-11-10T03:00:00.000Z");

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await database.db.execute(sql`truncate jobs, solver_sessions restart identity cascade`);
  store = createMemoryStore();
});

async function photoSession(input: {
  ownerId?: string;
  createdAt?: Date;
  status?: string;
  stage?: "photo" | "upload";
  deletedAt?: Date | null;
}) {
  const ownerId = input.ownerId ?? USER_A;
  const id = await seedSession(db(), {
    ownerId,
    inputKind: "photo",
    status: input.status ?? "solved",
    confirmedMd: input.status === "pending" ? null : "Hitung 2 + 2.",
    createdAt: input.createdAt ?? STARTED,
    deletedAt: input.deletedAt ?? null,
  });
  const key =
    input.stage === "upload"
      ? photoStagingKey(ownerId, id, "jpg")
      : photoKey(ownerId, id, "jpg");
  await store.put(key, makePhoto("jpeg"), "image/jpeg");
  await database.db
    .update(solverSessions)
    .set({ inputKey: key })
    .where(eq(solverSessions.id, id));
  return { id, key };
}
const rowOf = async (id: string) =>
  (await database.db.select().from(solverSessions).where(eq(solverSessions.id, id))).at(
    0,
  );

describe("the 7-day photo sweep (daily run)", () => {
  it("deletes photos whose session started 7 days ago, and only those", async () => {
    const old = await photoSession({});
    const trashed = await photoSession({ deletedAt: STARTED });
    const other = await photoSession({ ownerId: USER_B });
    const fresh = await photoSession({
      createdAt: new Date(STARTED.getTime() + 3_600_000),
    });
    const unsent = await photoSession({ status: "pending", stage: "upload" });

    // One hour short of 7 days: nothing goes.
    const early = new Date(STARTED.getTime() + PHOTO_RETENTION_MS - 3_600_000);
    expect(await sweepSolverPhotos(db(), store, early)).toEqual({
      deleted: 0,
      failed: 0,
    });
    expect(await store.get(old.key)).not.toBeNull();

    // The run at the 7-day mark (fake clock): the photos of 7 days are gone.
    const tick = new Date(STARTED.getTime() + PHOTO_RETENTION_MS);
    expect(await sweepSolverPhotos(db(), store, tick)).toEqual({
      deleted: 5 - 1,
      failed: 0,
    });
    for (const gone of [old, trashed, other, unsent]) {
      expect(await store.get(gone.key)).toBeNull();
    }
    expect(await store.get(fresh.key)).not.toBeNull();
    // The session stays (its text and solutions), without its photo.
    expect(await rowOf(old.id)).toMatchObject({ inputKey: null, status: "solved" });
    expect(await rowOf(other.id)).toMatchObject({ inputKey: null });
    // An upload never finished has nothing else to keep: its row goes too.
    expect(await rowOf(unsent.id)).toBeUndefined();
    // Idempotent.
    expect(await sweepSolverPhotos(db(), store, tick)).toEqual({ deleted: 0, failed: 0 });
  });

  it("deletes the session's own prefix whatever its column names (ids only, R13)", async () => {
    const victim = await photoSession({ ownerId: USER_B, createdAt: new Date() });
    const forged = await photoSession({});
    await database.db
      .update(solverSessions)
      .set({ inputKey: victim.key })
      .where(eq(solverSessions.id, forged.id));
    await sweepSolverPhotos(
      db(),
      store,
      new Date(STARTED.getTime() + PHOTO_RETENTION_MS),
    );
    expect(await store.get(victim.key)).not.toBeNull();
    expect(await store.get(forged.key)).toBeNull();
  });

  it("isolates a failing row and stops when its time is up", async () => {
    const first = await photoSession({});
    const second = await photoSession({ createdAt: new Date(STARTED.getTime() + 1_000) });
    const failing: ObjectStore = {
      ...store,
      deletePrefix: (prefix) =>
        prefix.includes(first.id)
          ? Promise.reject(new Error("R2 down"))
          : store.deletePrefix(prefix),
    };
    const tick = new Date(STARTED.getTime() + PHOTO_RETENTION_MS + 60_000);
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    expect(await sweepSolverPhotos(db(), failing, tick)).toEqual({
      deleted: 1,
      failed: 1,
    });
    // Ids and the error name only: never the message or a key.
    expect(JSON.stringify(error.mock.calls)).not.toContain("R2 down");
    expect(JSON.stringify(error.mock.calls)).not.toContain("solver/");
    error.mockRestore();
    expect(await rowOf(first.id)).toMatchObject({ inputKey: first.key });
    expect(await rowOf(second.id)).toMatchObject({ inputKey: null });

    const third = await photoSession({});
    expect(await sweepSolverPhotos(db(), store, tick, { outOfTime: () => true })).toEqual(
      { deleted: 0, failed: 0 },
    );
    expect(await store.get(third.key)).not.toBeNull();
  });

  it("runs inside the housekeeping without throwing", async () => {
    const old = await photoSession({});
    const broken = () => {
      throw new Error("no store");
    };
    const tick = new Date(STARTED.getTime() + PHOTO_RETENTION_MS);
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const onFailure = vi.fn();
    expect(await runSolverHousekeeping(db(), broken, tick, { onFailure })).toEqual({
      photos: { deleted: 0, failed: 0 },
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
    error.mockRestore();
    expect(await runSolverHousekeeping(db(), () => store, tick)).toEqual({
      photos: { deleted: 1, failed: 0 },
    });
    expect(await store.get(old.key)).toBeNull();
  });

  it("reports a budget that stopped the sweep with photos left", async () => {
    const old = await photoSession({});
    const tick = new Date(STARTED.getTime() + PHOTO_RETENTION_MS);
    const onBacklog = vi.fn();
    await runSolverHousekeeping(db(), () => store, tick, { budgetMs: 0, onBacklog });
    expect(onBacklog).toHaveBeenCalledTimes(1);
    expect(await store.get(old.key)).not.toBeNull();
    const done = vi.fn();
    await runSolverHousekeeping(db(), () => store, tick, { onBacklog: done });
    expect(done).not.toHaveBeenCalled();
  });
});

describe("a row that keeps failing", () => {
  it("goes to the back of the queue so newer photos are still deleted", async () => {
    const stuck = await photoSession({});
    const next = await photoSession({ createdAt: new Date(STARTED.getTime() + 1_000) });
    const failing: ObjectStore = {
      ...store,
      deletePrefix: (prefix) =>
        prefix.includes(stuck.id)
          ? Promise.reject(new Error("R2 down"))
          : store.deletePrefix(prefix),
    };
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const tick = new Date(STARTED.getTime() + PHOTO_RETENTION_MS + 60_000);
    expect(await sweepSolverPhotos(db(), failing, tick, { batch: 1 })).toEqual({
      deleted: 0,
      failed: 1,
    });
    const later = new Date(tick.getTime() + 3_600_000);
    expect(await sweepSolverPhotos(db(), failing, later, { batch: 1 })).toEqual({
      deleted: 1,
      failed: 0,
    });
    error.mockRestore();
    expect(await rowOf(next.id)).toMatchObject({ inputKey: null });
    // Only the sweep's own column moved, never the session's updated_at.
    expect(await rowOf(stuck.id)).toMatchObject({
      inputKey: stuck.key,
      photoSweepAttemptedAt: tick,
      updatedAt: STARTED,
    });
  });
});

describe("a session the teacher keeps using", () => {
  it("still loses its photo at 7 days, in created order, whatever updated_at says", async () => {
    const touched = await photoSession({});
    const other = await photoSession({ createdAt: new Date(STARTED.getTime() + 1_000) });
    const tick = new Date(STARTED.getTime() + PHOTO_RETENTION_MS + 60_000);
    // The teacher opened and changed it just now (a newer updated_at than any other row).
    await database.db
      .update(solverSessions)
      .set({ updatedAt: tick })
      .where(eq(solverSessions.id, touched.id));
    expect(await sweepSolverPhotos(db(), store, tick, { batch: 1 })).toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(await rowOf(touched.id)).toMatchObject({ inputKey: null });
    expect(await rowOf(other.id)).toMatchObject({ inputKey: other.key });
  });
});
