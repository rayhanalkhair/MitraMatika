import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { materials, materialUploads } from "@/lib/db/schema";
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
import { STORAGE_CAP_BYTES } from "../schema/upload";
import { startUpload, type MaterialDb } from "./upload";

// ADR-0022: the app-wide 6 GiB cap on the upload reservation path.
let database: TestDatabase;
let store: MemoryStore;
const db = () => database.db as unknown as MaterialDb;
const NOW = new Date("2026-11-22T03:00:00.000Z");
const MB = 1024 * 1024;
// A third account holds the bulk of the app, so neither teacher under test is near her own quota.
const USER_C = "33333333-3333-3333-3333-333333333333";

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await database.db.execute(
    sql`truncate jobs, materials, material_uploads, folders restart identity cascade`,
  );
  await database.db.execute(
    sql`insert into "user" (id, name, email, email_verified) values (${USER_C}, 'C', 'c@example.test', true) on conflict do nothing`,
  );
  await database.db.execute(
    sql`insert into profiles (id, display_name) values (${USER_C}, 'C') on conflict do nothing`,
  );
  store = createMemoryStore({ uploadPath: "/api/dev/upload" });
  vi.restoreAllMocks();
});

const start = (ownerId: string, size: number) =>
  startUpload(db(), store, {
    ownerId,
    fileName: "buku.pdf",
    declaredType: "",
    size,
    now: NOW,
  });
const reservations = async () =>
  (await database.db.select().from(materialUploads)).length;

/** Stored bytes of `ownerId` (a row only; the cap sums rows). */
async function seedStored(ownerId: string, bytes: number) {
  const id = crypto.randomUUID();
  await database.db.insert(materials).values({
    id,
    ownerId,
    title: "Buku lama",
    kind: "pdf",
    mime: "application/pdf",
    sizeBytes: bytes,
    sha256: "0".repeat(64),
    objectKey: `materials/${ownerId}/${id}/source.pdf`,
  });
}

describe("startUpload and the app-wide cap", () => {
  it(
    "accepts a start that brings the app exactly to the cap and refuses the next byte",
    async () => {
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      await seedStored(USER_C, APP_STORAGE_CAP_BYTES - 2 * MB);
      const exact = await start(USER_A, 2 * MB);
      expect(exact.ok).toBe(true);
      expect((await appStorageUsage(db())).usedBytes).toBe(APP_STORAGE_CAP_BYTES);
      expect(await start(USER_A, 1)).toEqual({ ok: false, error: "appFull" });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses another teacher once the first start took the last room",
    async () => {
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      await seedStored(USER_C, APP_STORAGE_CAP_BYTES - MB);
      expect((await start(USER_A, MB)).ok).toBe(true);
      expect(await start(USER_B, MB)).toEqual({ ok: false, error: "appFull" });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "creates no reservation and signs no URL when it refuses, and logs one warn without owner data",
    async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      const sign = vi.spyOn(store, "signedPutUrl");
      await seedStored(USER_C, APP_STORAGE_CAP_BYTES);
      expect(await start(USER_A, MB)).toEqual({ ok: false, error: "appFull" });
      expect(await reservations()).toBe(0);
      expect(sign).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      const [fields] = warn.mock.calls[0] as [Record<string, unknown>];
      expect(Object.keys(fields).sort()).toEqual([
        "capBytes",
        "module",
        "usedBytes",
        "writer",
      ]);
      expect(fields.writer).toBe("materials");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "reports the teacher's own quota before the app total when both would refuse",
    async () => {
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      await seedStored(USER_A, STORAGE_CAP_BYTES);
      await seedStored(USER_C, APP_STORAGE_CAP_BYTES);
      expect(await start(USER_A, MB)).toEqual({ ok: false, error: "quota" });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "counts an expired reservation that was not swept yet (its staging object still exists)",
    async () => {
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      // C's expired reservation is not swept by A's start (the sweep is per owner).
      await database.db.insert(materialUploads).values({
        ownerId: USER_C,
        objectKey: `uploads/${USER_C}/${crypto.randomUUID()}/source.pdf`,
        kind: "pdf",
        mime: "application/pdf",
        sizeBytes: APP_STORAGE_CAP_BYTES - MB,
        expiresAt: new Date(NOW.getTime() - 60_000),
      });
      expect((await start(USER_A, MB)).ok).toBe(true);
      expect(await start(USER_A, MB)).toEqual({ ok: false, error: "appFull" });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "gives exactly one reservation to two teachers who start together with room for one",
    async () => {
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      // Both are far under their own 300 MB; the app has room for one 1 MB start only.
      await seedStored(USER_C, APP_STORAGE_CAP_BYTES - MB - 10);
      const results = await Promise.all([start(USER_A, MB), start(USER_B, MB)]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        { ok: false, error: "appFull" },
      ]);
      expect(await reservations()).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "gives exactly one reservation when several starts race for the last room",
    async () => {
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      await seedStored(USER_C, APP_STORAGE_CAP_BYTES - 3 * MB);
      const results = await Promise.all(
        [USER_A, USER_B, USER_A, USER_B, USER_A].map((owner) => start(owner, 3 * MB)),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(await reservations()).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "takes the per-owner lock first and the app lock last (one fixed order)",
    async () => {
      const dialect = new PgDialect();
      const locks: string[] = [];
      const recording = new Proxy(database.db, {
        get(target, prop, receiver) {
          if (prop !== "transaction")
            return Reflect.get(target, prop, receiver) as unknown;
          return (callback: (tx: unknown) => Promise<unknown>) =>
            target.transaction((tx) =>
              callback(
                new Proxy(tx, {
                  get(inner, name, innerReceiver) {
                    if (name !== "execute")
                      return Reflect.get(inner, name, innerReceiver) as unknown;
                    return (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
                      const { sql: text, params } = dialect.sqlToQuery(query);
                      if (text.includes("pg_advisory_xact_lock")) {
                        locks.push(params.length > 0 ? String(params[0]) : text);
                      }
                      return inner.execute(query);
                    };
                  },
                }),
              ),
            );
        },
      }) as unknown as MaterialDb;
      const result = await startUpload(recording, store, {
        ownerId: USER_A,
        fileName: "buku.pdf",
        declaredType: "",
        size: MB,
        now: NOW,
      });
      expect(result.ok).toBe(true);
      expect(locks).toHaveLength(2);
      expect(locks[0]).toBe(`material_upload:${USER_A}`);
      expect(locks[1]).toContain("hashtextextended('app_storage_cap'");
    },
    DB_TEST_TIMEOUT,
  );
});
