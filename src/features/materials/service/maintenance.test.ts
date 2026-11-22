import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { jobs, materialPages, materials, materialUploads } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { logger } from "@/lib/logger";
import { createMemoryStore } from "@/lib/storage/memory";
import type { ObjectStore } from "@/lib/storage/types";
import { seedMaterial, seedPages } from "../fixtures/library";
import { INGEST_MATERIAL_JOB } from "../schema/upload";
import {
  runMaterialHousekeeping,
  STUCK_AFTER_MS,
  sweepExpiredUploads,
  sweepStuckMaterials,
} from "./maintenance";
import type { MaterialDb } from "./upload";

let database: TestDatabase;
const db = () => database.db as unknown as MaterialDb;
const NOW = new Date("2026-11-20T03:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await database.db.execute(
    sql`truncate jobs, materials, material_uploads, folders restart identity cascade`,
  );
});

async function ingestJob(ownerId: string, materialId: string, status: string) {
  await database.db.insert(jobs).values({
    ownerId,
    type: INGEST_MATERIAL_JOB,
    payload: { materialId },
    status,
  });
}
const statusOf = async (id: string) =>
  (await database.db.select().from(materials).where(eq(materials.id, id)))[0].status;

describe("sweepStuckMaterials", () => {
  it("fails a material left uploaded or processing without a live ingest job", async () => {
    const old = ago(STUCK_AFTER_MS + 60_000);
    const noJob = await seedMaterial(database, {
      ownerId: USER_A,
      status: "uploaded",
      updatedAt: old,
    });
    const deadJob = await seedMaterial(database, {
      ownerId: USER_A,
      status: "processing",
      updatedAt: old,
    });
    await ingestJob(USER_A, deadJob, "failed");
    const queued = await seedMaterial(database, {
      ownerId: USER_A,
      status: "uploaded",
      updatedAt: old,
    });
    await ingestJob(USER_A, queued, "queued");
    const deferred = await seedMaterial(database, {
      ownerId: USER_A,
      status: "processing",
      updatedAt: old,
    });
    await ingestJob(USER_A, deferred, "deferred");
    const running = await seedMaterial(database, {
      ownerId: USER_A,
      status: "processing",
      updatedAt: old,
    });
    await ingestJob(USER_A, running, "running");
    // Another teacher's live job naming this material does not keep it alive.
    const foreignJob = await seedMaterial(database, {
      ownerId: USER_A,
      status: "processing",
      updatedAt: old,
    });
    await ingestJob(USER_B, foreignJob, "queued");
    const recent = await seedMaterial(database, {
      ownerId: USER_A,
      status: "uploaded",
      updatedAt: ago(60_000),
    });
    const trashed = await seedMaterial(database, {
      ownerId: USER_A,
      status: "processing",
      updatedAt: old,
      deletedAt: old,
      purgeAfter: NOW,
    });
    const ready = await seedMaterial(database, {
      ownerId: USER_A,
      status: "ready",
      updatedAt: old,
    });

    expect(await sweepStuckMaterials(db(), NOW)).toBe(3);
    expect(await statusOf(noJob)).toBe("failed");
    expect(await statusOf(deadJob)).toBe("failed");
    expect(await statusOf(foreignJob)).toBe("failed");
    for (const id of [queued, deferred, running])
      expect(await statusOf(id)).not.toBe("failed");
    expect(await statusOf(recent)).toBe("uploaded");
    expect(await statusOf(trashed)).toBe("processing");
    expect(await statusOf(ready)).toBe("ready");
    // Idempotent.
    expect(await sweepStuckMaterials(db(), NOW)).toBe(0);
  });

  it("takes at most one batch per run", async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedMaterial(database, {
        ownerId: USER_A,
        status: "uploaded",
        updatedAt: ago(STUCK_AFTER_MS + 1),
      });
    }
    expect(await sweepStuckMaterials(db(), NOW, { batch: 2 })).toBe(2);
    expect(await sweepStuckMaterials(db(), NOW, { batch: 2 })).toBe(1);
  });
});

describe("sweepExpiredUploads", () => {
  async function reservation(
    ownerId: string,
    input: {
      expiresAt: Date;
      cancelledAt?: Date;
      claimedAt?: Date;
      key?: string;
      object?: boolean;
    },
    store: ObjectStore,
  ) {
    const id = crypto.randomUUID();
    const objectKey = input.key ?? `uploads/${ownerId}/${id}/source.pdf`;
    await database.db.insert(materialUploads).values({
      id,
      ownerId,
      objectKey,
      kind: "pdf",
      mime: "application/pdf",
      sizeBytes: 3,
      expiresAt: input.expiresAt,
      cancelledAt: input.cancelledAt ?? null,
      claimToken: input.claimedAt ? crypto.randomUUID() : null,
      claimedAt: input.claimedAt ?? null,
    });
    if (input.object !== false) {
      await store.put(objectKey, new Uint8Array([1, 2, 3]), "application/pdf");
    }
    return { id, objectKey };
  }
  const rows = async () =>
    (await database.db.select().from(materialUploads)).map((row) => row.id).sort();

  it("removes expired reservations (cancelled ones too) and their staging objects, and only those", async () => {
    const store = createMemoryStore();
    const expired = await reservation(USER_A, { expiresAt: ago(1) }, store);
    const cancelledExpired = await reservation(
      USER_A,
      { expiresAt: ago(1), cancelledAt: ago(10 * 60_000) },
      store,
    );
    const noObject = await reservation(
      USER_B,
      { expiresAt: ago(1), object: false },
      store,
    );
    const cancelledLive = await reservation(
      USER_A,
      { expiresAt: new Date(NOW.getTime() + 60_000), cancelledAt: ago(1) },
      store,
    );
    const live = await reservation(
      USER_A,
      { expiresAt: new Date(NOW.getTime() + 60_000) },
      store,
    );
    const freshClaim = await reservation(
      USER_A,
      { expiresAt: ago(1), claimedAt: ago(60_000) },
      store,
    );

    expect(await sweepExpiredUploads(db(), store, NOW)).toEqual({
      deleted: 3,
      failed: 0,
    });
    expect(await rows()).toEqual([cancelledLive.id, live.id, freshClaim.id].sort());
    expect(await store.get(expired.objectKey)).toBeNull();
    expect(await store.get(cancelledExpired.objectKey)).toBeNull();
    expect(await store.get(noObject.objectKey)).toBeNull();
    expect(await store.get(cancelledLive.objectKey)).not.toBeNull();
    expect(await store.get(live.objectKey)).not.toBeNull();
    expect(await store.get(freshClaim.objectKey)).not.toBeNull();
  });

  it("never deletes an object outside the row owner's staging prefix", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const store = createMemoryStore();
    const victim = `materials/${USER_B}/${crypto.randomUUID()}/source.pdf`;
    await store.put(victim, new Uint8Array([9]), "application/pdf");
    await reservation(USER_A, { expiresAt: ago(1), key: victim, object: false }, store);
    expect(await sweepExpiredUploads(db(), store, NOW)).toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(await store.get(victim)).not.toBeNull();
    expect(await rows()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps the row when the object cannot be deleted, and stops when out of time", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const inner = createMemoryStore();
    const failing: ObjectStore = {
      ...inner,
      delete: () => Promise.reject(new Error("storage down")),
    };
    const first = await reservation(USER_A, { expiresAt: ago(2) }, inner);
    expect(await sweepExpiredUploads(db(), failing, NOW)).toEqual({
      deleted: 0,
      failed: 1,
    });
    expect(await rows()).toEqual([first.id]);
    // Logged by error name only, never the key or the message.
    expect(JSON.stringify(error.mock.calls)).not.toContain("storage down");
    expect(JSON.stringify(error.mock.calls)).not.toContain(first.objectKey);

    await reservation(USER_A, { expiresAt: ago(1) }, inner);
    let calls = 0;
    expect(
      await sweepExpiredUploads(db(), inner, NOW, {
        outOfTime: () => {
          calls += 1;
          return calls > 1;
        },
      }),
    ).toEqual({ deleted: 1, failed: 0 });
    expect(await rows()).toHaveLength(1);
  });

  it("reports a sweep that failed and a budget that stopped the upload sweep", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const store = createMemoryStore();
    await reservation(USER_A, { expiresAt: ago(1) }, store);
    const onBacklog = vi.fn();
    const onFailure = vi.fn();
    await runMaterialHousekeeping(db(), () => store, NOW, {
      budgetMs: 0,
      onBacklog,
      onFailure,
    });
    expect(onBacklog).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(1);

    const clean = { onBacklog: vi.fn(), onFailure: vi.fn() };
    await runMaterialHousekeeping(db(), () => store, NOW, clean);
    expect(clean.onBacklog).not.toHaveBeenCalled();
    expect(clean.onFailure).not.toHaveBeenCalled();

    const broken = {
      select: () => {
        throw new Error("db down");
      },
      update: () => {
        throw new Error("db down");
      },
    } as unknown as MaterialDb;
    const failed = vi.fn();
    await runMaterialHousekeeping(broken, () => store, NOW, { onFailure: failed });
    expect(failed).toHaveBeenCalled();
  });
});

describe("runMaterialHousekeeping", () => {
  it("runs every sweep and reports their counts, never throwing", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const store = createMemoryStore();
    await seedMaterial(database, {
      ownerId: USER_A,
      status: "processing",
      updatedAt: ago(STUCK_AFTER_MS + 1),
    });
    // A page left queued by an OCR job that died.
    const scanned = await seedMaterial(database, { ownerId: USER_A });
    await seedPages(database, { ownerId: USER_A, materialId: scanned, texts: [""] });
    await database.db.update(materialPages).set({ ocrStatus: "queued" });
    expect(await runMaterialHousekeeping(db(), () => store, NOW)).toEqual({
      stuck: 1,
      ocrPages: 1,
      uploads: { deleted: 0, failed: 0 },
    });
    const broken = {
      select: () => {
        throw new Error("db down");
      },
      update: () => {
        throw new Error("db down");
      },
    } as unknown as MaterialDb;
    await expect(runMaterialHousekeeping(broken, () => store, NOW)).resolves.toEqual({
      stuck: 0,
      ocrPages: 0,
      uploads: { deleted: 0, failed: 0 },
    });
    expect(error).toHaveBeenCalledTimes(3);
  });
});
