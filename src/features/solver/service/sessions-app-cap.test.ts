import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { materials, solverSessions } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { logger } from "@/lib/logger";
import { APP_STORAGE_CAP_BYTES, appStorageUsage } from "@/lib/storage/app-total";
import { createMemoryStore, type MemoryStore } from "@/lib/storage/memory";
import { makePhoto } from "../test-support";
import { photoStagingKey } from "./keys";
import type { SolverDb } from "./quota";
import { finalizePhotoSession, startPhotoSession } from "./sessions";

// ADR-0022: the app-wide 6 GiB cap on the solver photo reservation.
let database: TestDatabase;
let store: MemoryStore;
const db = () => database.db as unknown as SolverDb;
const NOW = new Date("2026-11-20T03:00:00.000Z");

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await database.db.execute(
    sql`truncate jobs, solver_sessions, materials restart identity cascade`,
  );
  store = createMemoryStore({ uploadPath: "/api/dev/upload" });
  vi.restoreAllMocks();
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

/** Another teacher's stored file, so that exactly `room` bytes are left in the app. */
async function leaveRoom(room: number) {
  const { usedBytes } = await appStorageUsage(db());
  const id = crypto.randomUUID();
  await database.db.insert(materials).values({
    id,
    ownerId: USER_B,
    title: "Buku",
    kind: "pdf",
    mime: "application/pdf",
    sizeBytes: APP_STORAGE_CAP_BYTES - usedBytes - room,
    sha256: "0".repeat(64),
    objectKey: `materials/${USER_B}/${id}/source.pdf`,
  });
}
const start = (size: number, ownerId = USER_A) =>
  startPhotoSession(db(), store, {
    ownerId,
    kind: "photo",
    mime: "image/png",
    size,
    now: NOW,
  });
const sessions = async () => database.db.select().from(solverSessions);

describe("startPhotoSession and the app-wide cap", () => {
  it(
    "records the declared size and passes at exactly the cap",
    async () => {
      await leaveRoom(5000);
      const started = await start(5000);
      expect(started.ok).toBe(true);
      expect((await sessions())[0]).toMatchObject({ inputBytes: 5000 });
      expect((await appStorageUsage(db())).usedBytes).toBe(APP_STORAGE_CAP_BYTES);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses one byte more, with no session, no signed URL and one warn line",
    async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      const sign = vi.spyOn(store, "signedPutUrl");
      await leaveRoom(4999);
      expect(await start(5000)).toEqual({ ok: false, error: "appFull" });
      expect(await sessions()).toHaveLength(0);
      expect(sign).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatchObject({
        module: "storage",
        writer: "solver",
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "gives exactly one reservation to two teachers who start together with room for one",
    async () => {
      await leaveRoom(5000);
      const results = await Promise.all([start(5000, USER_A), start(5000, USER_B)]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(await sessions()).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "replaces the declared size by the stored size when the photo is finalised",
    async () => {
      const started = await start(2_000_000);
      if (!started.ok) throw new Error(started.error);
      const photo = makePhoto("png");
      await store.put(
        photoStagingKey(USER_A, started.data.sessionId, "png"),
        photo,
        "image/png",
      );
      const finalized = await finalizePhotoSession(db(), store, {
        ownerId: USER_A,
        sessionId: started.data.sessionId,
        now: NOW,
      });
      expect(finalized.ok).toBe(true);
      const row = (
        await database.db
          .select()
          .from(solverSessions)
          .where(eq(solverSessions.id, started.data.sessionId))
      )[0];
      expect(row.inputBytes).toBeGreaterThan(0);
      expect(row.inputBytes).toBeLessThanOrEqual(photo.length);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "stops counting a photo once its key is cleared (the 7-day sweep)",
    async () => {
      await start(5000);
      expect((await appStorageUsage(db())).parts.photos).toBe(5000);
      await database.db.execute(sql`update solver_sessions set input_key = null`);
      expect((await appStorageUsage(db())).parts.photos).toBe(0);
    },
    DB_TEST_TIMEOUT,
  );
});
