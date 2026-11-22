import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import { FIXTURE, seedFixtures } from "@/lib/db/test-fixtures";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import {
  APP_STORAGE_CAP_BYTES,
  appStorageUsage,
  assertAppStorageRoom,
  lockAppStorage,
  type AppTotalDb,
} from "./app-total";

let database: TestDatabase;
const db = () => database.db as unknown as AppTotalDb;
const run = (statement: string) => database.db.execute(sql.raw(statement));

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});

// Owner 1 is USER_A and owner 2 is USER_B in the fixtures. Every source holds a known size:
// materials 1000 / 10, pages 200 / 20, uploads 3000 / 30, exports 40000 / 400,
// logos 5000 / 50 and photos 60000 / 600 (A / B).
async function seedBoth() {
  const sizes: [1 | 2, string, number, number, number, number, number, number][] = [
    [1, USER_A, 1000, 200, 3000, 40000, 5000, 60000],
    [2, USER_B, 10, 20, 30, 400, 50, 600],
  ];
  for (const [o, user, mat, page, up, exp, logo, photo] of sizes) {
    await run(
      `update materials set size_bytes = ${String(mat)} where id = '${FIXTURE.material(o)}'`,
    );
    await run(
      `update material_pages set image_bytes = ${String(page)} where id = '${FIXTURE.materialPage(o)}'`,
    );
    await run(
      `update material_uploads set size_bytes = ${String(up)} where id = '${FIXTURE.materialUpload(o)}'`,
    );
    await run(
      `update exports set size_bytes = ${String(exp)} where id = '${FIXTURE.export(o)}'`,
    );
    await run(
      `update school_templates set logo_key = 'logos/${user}/x.png', logo_bytes = ${String(logo)} where id = '${FIXTURE.template(o)}'`,
    );
    await run(
      `update solver_sessions set input_key = 'solver/${user}/x.png', input_bytes = ${String(photo)} where id = '${FIXTURE.solverSession(o)}'`,
    );
  }
}

beforeEach(async () => {
  await run(
    `truncate "user", profiles, jobs, materials, material_uploads, exports, school_templates, solver_sessions, assessments, folders restart identity cascade`,
  );
  await run(
    `insert into "user" (id, name, email, email_verified) values ('${USER_A}', 'A', 'a@example.test', true), ('${USER_B}', 'B', 'b@example.test', true)`,
  );
  await run(
    `insert into profiles (id, display_name) values ('${USER_A}', 'A'), ('${USER_B}', 'B')`,
  );
  await run(`truncate curriculum_versions restart identity cascade`);
  await seedFixtures(database.db);
  vi.restoreAllMocks();
});

describe("APP_STORAGE_CAP_BYTES", () => {
  it("is exactly 6 GiB", () => {
    expect(APP_STORAGE_CAP_BYTES).toBe(6 * 1024 * 1024 * 1024);
  });
});

describe("appStorageUsage", () => {
  it(
    "sums each of the six sources over every owner",
    async () => {
      await seedBoth();
      const usage = await appStorageUsage(db());
      expect(usage.capBytes).toBe(APP_STORAGE_CAP_BYTES);
      expect(usage.parts).toEqual({
        materials: 1010,
        pages: 220,
        uploads: 3030,
        exports: 40400,
        logos: 5050,
        photos: 60600,
      });
      expect(usage.usedBytes).toBe(1010 + 220 + 3030 + 40400 + 5050 + 60600);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "counts trashed materials, trashed templates and expired but unswept reservations",
    async () => {
      await seedBoth();
      await run(
        `update materials set deleted_at = now() where id = '${FIXTURE.material(1)}'`,
      );
      await run(
        `update school_templates set deleted_at = now(), purge_after = now() where id = '${FIXTURE.template(1)}'`,
      );
      // The fixture reservation of owner 1 expired in 2026-11-20 (before today's clock).
      const usage = await appStorageUsage(db());
      expect(usage.parts.materials).toBe(1010);
      expect(usage.parts.logos).toBe(5050);
      expect(usage.parts.uploads).toBe(3030);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "counts nothing for null size columns and for a solver session without a stored photo",
    async () => {
      await seedBoth();
      await run(`update material_pages set image_bytes = null`);
      await run(
        `update school_templates set logo_key = null, logo_bytes = null where id = '${FIXTURE.template(2)}'`,
      );
      // A swept photo: key cleared, size left behind by a writer that forgot it.
      await run(
        `update solver_sessions set input_key = null where id = '${FIXTURE.solverSession(1)}'`,
      );
      const usage = await appStorageUsage(db());
      expect(usage.parts.pages).toBe(0);
      expect(usage.parts.logos).toBe(5000);
      expect(usage.parts.photos).toBe(600);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "an empty database is zero in every part",
    async () => {
      await run(
        `truncate materials, material_uploads, exports, school_templates, solver_sessions, assessments, folders cascade`,
      );
      const usage = await appStorageUsage(db());
      expect(usage.usedBytes).toBe(0);
      expect(Object.values(usage.parts)).toEqual([0, 0, 0, 0, 0, 0]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "falls by exactly an owner's rows when the account is deleted (cascade)",
    async () => {
      await seedBoth();
      const before = await appStorageUsage(db());
      await database.db.execute(sql`delete from "user" where id = ${USER_B}`);
      const after = await appStorageUsage(db());
      expect(before.usedBytes - after.usedBytes).toBe(10 + 20 + 30 + 400 + 50 + 600);
      expect(after.parts.materials).toBe(1000);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "falls when rows are purged, export rows expire or a photo is swept",
    async () => {
      await seedBoth();
      const before = await appStorageUsage(db());
      await run(`delete from exports where id = '${FIXTURE.export(1)}'`);
      await run(
        `update solver_sessions set input_key = null where id = '${FIXTURE.solverSession(2)}'`,
      );
      const after = await appStorageUsage(db());
      expect(before.usedBytes - after.usedBytes).toBe(40000 + 600);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("assertAppStorageRoom", () => {
  it(
    "passes at exactly the cap and refuses one byte more",
    async () => {
      await seedBoth();
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      const { usedBytes } = await appStorageUsage(db());
      const exact = await assertAppStorageRoom(
        db(),
        APP_STORAGE_CAP_BYTES - usedBytes,
        "materials",
      );
      expect(exact).toEqual({ ok: true, data: { usedBytes } });
      const over = await assertAppStorageRoom(
        db(),
        APP_STORAGE_CAP_BYTES - usedBytes + 1,
        "materials",
      );
      expect(over).toEqual({ ok: false, error: "appFull" });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "writes one warn line with only module, writer, usedBytes and capBytes per refusal",
    async () => {
      await seedBoth();
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      await assertAppStorageRoom(db(), APP_STORAGE_CAP_BYTES, "solver");
      expect(warn).toHaveBeenCalledTimes(1);
      const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
      expect(Object.keys(fields).sort()).toEqual([
        "capBytes",
        "module",
        "usedBytes",
        "writer",
      ]);
      expect(fields).toMatchObject({ module: "storage", writer: "solver" });
      expect(message).toBe("storage: the app-wide cap refused a new upload");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "logs nothing when there is room",
    async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      expect((await assertAppStorageRoom(db(), 1, "logo")).ok).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses a size that is not a non-negative safe integer",
    async () => {
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(await assertAppStorageRoom(db(), bad, "export")).toEqual({
          ok: false,
          error: "appFull",
        });
      }
    },
    DB_TEST_TIMEOUT,
  );
});

describe("lockAppStorage", () => {
  it(
    "takes the transaction advisory lock of the key app_storage_cap and frees it at commit",
    async () => {
      const held = sql`select exists (
        select 1 from pg_locks
        where locktype = 'advisory' and pid = pg_backend_pid()
          and ((classid::bigint << 32) | objid::bigint) = hashtextextended('app_storage_cap', 0)
      ) as held`;
      const inside = await database.db.transaction(async (tx) => {
        await lockAppStorage(tx);
        return tx.execute(held);
      });
      expect(inside.rows).toEqual([{ held: true }]);
      expect((await database.db.execute(held)).rows).toEqual([{ held: false }]);
    },
    DB_TEST_TIMEOUT,
  );
});
