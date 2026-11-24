import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  deletionLog,
  folders,
  jobs,
  materialPages,
  materials,
  materialSections,
} from "@/lib/db/schema";
import { FIXTURE, seedFixtures } from "@/lib/db/test-fixtures";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import type { AnyDb } from "@/features/generation";
import {
  INGEST_MATERIAL_JOB,
  materialSourceKey,
  startUpload,
  OCR_PAGES_JOB,
  PROPOSE_STRUCTURE_JOB,
} from "@/features/materials";
import {
  seedFolder,
  seedMaterial,
  seedPages,
} from "@/features/materials/fixtures/library";
import { listingStore } from "../db-test-support";
import {
  deleteFolderPermanently,
  deleteMaterialPermanently,
  listTrashedFolders,
  listTrashedMaterials,
  purgeExpiredFolders,
  purgeExpiredMaterials,
  restoreFolder,
  restoreMaterial,
  trashFolder,
  trashMaterial,
} from "./material-trash";
import { purgeTrashOncePerDay } from "./purge";
import {
  INGEST_MATERIAL_JOB_TYPE,
  materialPrefix,
  OCR_PAGES_JOB_TYPE,
  PROPOSE_STRUCTURE_JOB_TYPE,
} from "./storage-keys";

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
    sql`truncate audit_log, deletion_log, jobs, materials, material_uploads, folders restart identity cascade`,
  );
});

const materialRow = async (id: string) =>
  (await database.db.select().from(materials).where(eq(materials.id, id))).at(0);
const folderRow = async (id: string) =>
  (await database.db.select().from(folders).where(eq(folders.id, id))).at(0);

/** A material with stored files: its source and two page images (Task 6's layout). */
async function seedStoredMaterial(
  store: ReturnType<typeof listingStore>,
  ownerId: string,
  overrides: Parameters<typeof seedMaterial>[1] extends infer T ? Partial<T> : never = {},
) {
  const id = await seedMaterial(database, { ownerId, pageCount: 2, ...overrides });
  await seedPages(database, { ownerId, materialId: id, texts: ["satu", "dua"] });
  await database.db.insert(materialSections).values({
    ownerId,
    materialId: id,
    title: "Bab 1",
    pageStart: 1,
    pageEnd: 2,
  });
  const source = materialSourceKey(ownerId, id, "pdf");
  for (const key of [
    source,
    `materials/${ownerId}/${id}/pages/1.png`,
    `materials/${ownerId}/${id}/pages/2.png`,
  ]) {
    await store.put(key, new Uint8Array([1]), "application/octet-stream");
  }
  return id;
}

describe("the trash's material keys", () => {
  it("match the materials feature's layout and job types", () => {
    const id = crypto.randomUUID();
    expect(
      materialSourceKey(USER_A, id, "pdf").startsWith(materialPrefix(USER_A, id)),
    ).toBe(true);
    expect(materialPrefix(USER_A, id)).toBe(`materials/${USER_A}/${id}/`);
    expect(() => materialPrefix(USER_A, "../x")).toThrow();
    expect(INGEST_MATERIAL_JOB_TYPE).toBe(INGEST_MATERIAL_JOB);
    expect(PROPOSE_STRUCTURE_JOB_TYPE).toBe(PROPOSE_STRUCTURE_JOB);
    expect(OCR_PAGES_JOB_TYPE).toBe(OCR_PAGES_JOB);
  });
});

describe("material trash", () => {
  it("moves a material to the trash for 30 days and cancels its jobs that have not started", async () => {
    const id = await seedMaterial(database, { ownerId: USER_A, status: "processing" });
    await database.db.insert(jobs).values([
      {
        ownerId: USER_A,
        type: INGEST_MATERIAL_JOB,
        payload: { materialId: id },
        status: "deferred",
      },
      {
        ownerId: USER_A,
        type: PROPOSE_STRUCTURE_JOB,
        payload: { materialId: id },
        status: "queued",
      },
      {
        ownerId: USER_A,
        type: OCR_PAGES_JOB,
        payload: { materialId: id, pageNos: [1], day: "2026-11-20" },
        status: "deferred",
      },
      {
        ownerId: USER_A,
        type: INGEST_MATERIAL_JOB,
        payload: { materialId: crypto.randomUUID() },
        status: "queued",
      },
    ]);
    expect(
      await trashMaterial(db(), { ownerId: USER_A, materialId: id, now: NOW }),
    ).toEqual({
      ok: true,
      data: undefined,
    });
    const row = await materialRow(id);
    expect(row?.deletedAt).toEqual(NOW);
    expect(row?.purgeAfter).toEqual(new Date(NOW.getTime() + 30 * DAY_MS));
    const statuses = (await database.db.select().from(jobs)).map((job) => [
      (job.payload as { materialId: string }).materialId === id,
      job.status,
    ]);
    expect(statuses.sort()).toEqual([
      [false, "queued"],
      [true, "cancelled"],
      [true, "cancelled"],
      [true, "cancelled"],
    ]);
    // Again, or by another teacher: notFound.
    expect(
      await trashMaterial(db(), { ownerId: USER_A, materialId: id, now: NOW }),
    ).toEqual({
      ok: false,
      error: "notFound",
    });
    const other = await seedMaterial(database, { ownerId: USER_A });
    expect(
      await trashMaterial(db(), { ownerId: USER_B, materialId: other, now: NOW }),
    ).toEqual({ ok: false, error: "notFound" });
    expect((await materialRow(other))?.deletedAt).toBeNull();
  });

  it("ends pages queued for OCR as failed, so the teacher can send them again after a restore", async () => {
    const id = await seedMaterial(database, { ownerId: USER_A });
    await seedPages(database, { ownerId: USER_A, materialId: id, texts: ["", "", ""] });
    await database.db
      .update(materialPages)
      .set({ ocrStatus: "queued" })
      .where(and(eq(materialPages.materialId, id), sql`${materialPages.pageNo} < 3`));
    await database.db
      .update(materialPages)
      .set({ ocrStatus: "done" })
      .where(and(eq(materialPages.materialId, id), eq(materialPages.pageNo, 3)));
    await trashMaterial(db(), { ownerId: USER_A, materialId: id, now: NOW });
    const statuses = await database.db
      .select({ pageNo: materialPages.pageNo, ocrStatus: materialPages.ocrStatus })
      .from(materialPages)
      .where(eq(materialPages.materialId, id))
      .orderBy(materialPages.pageNo);
    expect(statuses.map((row) => row.ocrStatus)).toEqual(["failed", "failed", "done"]);
  });

  it("restores a material as it was, re-queues an unfinished ingestion and leaves a trashed folder", async () => {
    const folder = await seedFolder(database, { ownerId: USER_A });
    const done = await seedMaterial(database, { ownerId: USER_A, folderId: folder });
    const unfinished = await seedMaterial(database, {
      ownerId: USER_A,
      status: "processing",
      folderId: folder,
    });
    for (const id of [done, unfinished]) {
      await trashMaterial(db(), { ownerId: USER_A, materialId: id, now: NOW });
    }
    await database.db
      .update(folders)
      .set({ deletedAt: NOW, purgeAfter: NOW })
      .where(eq(folders.id, folder));

    expect(
      await restoreMaterial(db(), { ownerId: USER_A, materialId: done, now: NOW }),
    ).toEqual({
      ok: true,
      data: { requeued: false },
    });
    expect(
      await restoreMaterial(db(), { ownerId: USER_A, materialId: unfinished, now: NOW }),
    ).toEqual({ ok: true, data: { requeued: true } });
    expect(await materialRow(done)).toMatchObject({
      deletedAt: null,
      purgeAfter: null,
      status: "ready",
      // Its folder is in the trash: the material comes back at the top level.
      folderId: null,
    });
    const queued = await database.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, INGEST_MATERIAL_JOB), eq(jobs.status, "queued")));
    expect(queued.map((job) => [job.ownerId, job.payload])).toEqual([
      [USER_A, { materialId: unfinished }],
    ]);
    // Not in the trash any more; another teacher's.
    expect(
      await restoreMaterial(db(), { ownerId: USER_A, materialId: done, now: NOW }),
    ).toEqual({
      ok: false,
      error: "notInTrash",
    });
    expect(
      await restoreMaterial(db(), { ownerId: USER_B, materialId: done, now: NOW }),
    ).toEqual({
      ok: false,
      error: "notFound",
    });
  });

  it("keeps a teacher above the new 300 MB cap able to delete, and frees room as they do", async () => {
    // 400 MB was allowed under the old 1 GB cap; new uploads are refused, deleting still works.
    const store = listingStore();
    const big = await seedStoredMaterial(store, USER_A, { sizeBytes: 250 * 1024 * 1024 });
    const other = await seedStoredMaterial(store, USER_A, {
      sizeBytes: 150 * 1024 * 1024,
    });
    const start = () =>
      startUpload(db(), store, {
        ownerId: USER_A,
        fileName: "baru.pdf",
        declaredType: "",
        size: 1024 * 1024,
        now: NOW,
      });
    expect(await start()).toEqual({ ok: false, error: "quota" });

    // Trashing does not free room (trash counts); deleting for good does.
    await trashMaterial(db(), { ownerId: USER_A, materialId: big, now: NOW });
    expect(await start()).toEqual({ ok: false, error: "quota" });
    const deleted = await deleteMaterialPermanently(db(), () => store, {
      ownerId: USER_A,
      materialId: big,
      now: NOW,
    });
    expect(deleted.ok).toBe(true);
    expect(await materialRow(other)).toBeDefined();
    // 150 MB left: below the cap again, so a new upload is accepted.
    expect((await start()).ok).toBe(true);
  });

  it("deletes a trashed material for good with its file, page images, pages and sections", async () => {
    const store = listingStore();
    const id = await seedStoredMaterial(store, USER_A);
    const kept = await seedStoredMaterial(store, USER_B);
    await trashMaterial(db(), { ownerId: USER_A, materialId: id, now: NOW });

    // Another teacher cannot delete it; a live material is not in the trash.
    expect(
      await deleteMaterialPermanently(db(), () => store, {
        ownerId: USER_B,
        materialId: id,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "notFound" });
    expect(
      await deleteMaterialPermanently(db(), () => store, {
        ownerId: USER_B,
        materialId: kept,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "notInTrash" });

    const result = await deleteMaterialPermanently(db(), () => store, {
      ownerId: USER_A,
      materialId: id,
      now: NOW,
    });
    expect(result).toEqual({
      ok: true,
      data: { pages: 2, sections: 1, citations: 0, files: 3 },
    });
    expect(await materialRow(id)).toBeUndefined();
    expect(
      await database.db
        .select()
        .from(materialPages)
        .where(eq(materialPages.materialId, id)),
    ).toEqual([]);
    expect(
      await database.db
        .select()
        .from(materialSections)
        .where(eq(materialSections.materialId, id)),
    ).toEqual([]);
    expect(store.keys().filter((key) => key.includes(id))).toEqual([]);
    expect(store.keys().filter((key) => key.includes(kept))).toHaveLength(3);
    expect(await database.db.select().from(deletionLog)).toMatchObject([
      {
        ownerId: USER_A,
        entity: "material",
        entityId: id,
        counts: { materials: 1, pages: 2, sections: 1, citations: 0 },
      },
    ]);
  });

  it("rolls the rows back and keeps the files when the store fails", async () => {
    const store = listingStore({
      failPrefix: (prefix) => prefix.startsWith("materials/"),
    });
    const id = await seedStoredMaterial(store, USER_A);
    await trashMaterial(db(), { ownerId: USER_A, materialId: id, now: NOW });
    await expect(
      deleteMaterialPermanently(db(), () => store, {
        ownerId: USER_A,
        materialId: id,
        now: NOW,
      }),
    ).rejects.toThrow();
    expect((await materialRow(id))?.deletedAt).toEqual(NOW);
    expect(await database.db.select().from(deletionLog)).toEqual([]);
  });

  it("purges expired materials only, each on its own, within the time budget", async () => {
    const store = listingStore();
    const expired = await seedStoredMaterial(store, USER_A);
    const fresh = await seedStoredMaterial(store, USER_B);
    await trashMaterial(db(), { ownerId: USER_A, materialId: expired, now: NOW });
    await trashMaterial(db(), {
      ownerId: USER_B,
      materialId: fresh,
      now: new Date(NOW.getTime() + 5 * DAY_MS),
    });
    expect(await purgeExpiredMaterials(db(), () => store, LATER)).toEqual({
      purged: 1,
      failed: 0,
    });
    expect(await materialRow(expired)).toBeUndefined();
    expect((await materialRow(fresh))?.deletedAt).not.toBeNull();
    expect(
      await purgeExpiredMaterials(
        db(),
        () => store,
        new Date(LATER.getTime() + 10 * DAY_MS),
        {
          outOfTime: () => true,
        },
      ),
    ).toEqual({ purged: 0, failed: 0 });
  });

  it("lists the owner's trashed materials with what a delete would take", async () => {
    const store = listingStore();
    const id = await seedStoredMaterial(store, USER_A, { title: "Buku Lama" });
    await seedStoredMaterial(store, USER_A, { title: "Masih dipakai" });
    const theirs = await seedStoredMaterial(store, USER_B);
    await trashMaterial(db(), { ownerId: USER_A, materialId: id, now: NOW });
    await trashMaterial(db(), { ownerId: USER_B, materialId: theirs, now: NOW });
    expect(
      await listTrashedMaterials(db(), {
        ownerId: USER_A,
        now: new Date(NOW.getTime() + DAY_MS),
      }),
    ).toEqual([
      {
        materialId: id,
        title: "Buku Lama",
        kind: "pdf",
        pageCount: 2,
        sectionCount: 1,
        citationCount: 0,
        deletedAt: NOW.toISOString(),
        purgeAfter: new Date(NOW.getTime() + 30 * DAY_MS).toISOString(),
        daysLeft: 29,
      },
    ]);
  });

  it("joins the daily purge", async () => {
    const store = listingStore();
    const id = await seedStoredMaterial(store, USER_A);
    await trashMaterial(db(), { ownerId: USER_A, materialId: id, now: NOW });
    const folder = await seedFolder(database, {
      ownerId: USER_A,
      deletedAt: NOW,
      purgeAfter: NOW,
    });
    expect(await purgeTrashOncePerDay(db(), LATER, () => store)).toEqual({
      purged: 2,
      failed: 0,
    });
    expect(await materialRow(id)).toBeUndefined();
    expect(await folderRow(folder)).toBeUndefined();
    expect(store.keys()).toEqual([]);
  });
});

describe("a banked question citing a deleted material (MAT-11)", () => {
  it(
    "keeps the question and its anchor; the material link and stored excerpt go",
    async () => {
      const fresh = await createTestDatabase();
      try {
        await seedFixtures(fresh.db);
        const run = (statement: string) => fresh.db.execute(sql.raw(statement));
        const source = crypto.randomUUID();
        await run(
          `insert into question_sources (id, owner_id, question_version_id, kind, material_id, material_page_id, section_id, anchor_label, excerpt)
         values ('${source}', '${USER_A}', '${FIXTURE.version(1)}', 'material', '${FIXTURE.material(1)}', '${FIXTURE.materialPage(1)}', '${FIXTURE.materialSection(1)}', 'hal. 1', 'Pola bilangan ganjil')`,
        );
        const freshDb = fresh.db as unknown as AnyDb;
        await trashMaterial(freshDb, {
          ownerId: USER_A,
          materialId: FIXTURE.material(1),
          now: NOW,
        });
        const store = listingStore();
        const result = await deleteMaterialPermanently(freshDb, () => store, {
          ownerId: USER_A,
          materialId: FIXTURE.material(1),
          now: NOW,
        });
        expect(result.ok && result.data.citations).toBe(1);
        expect(
          (
            await run(
              `select kind, material_id, material_page_id, section_id, anchor_label, excerpt, question_version_id
             from question_sources where id = '${source}'`,
            )
          ).rows,
        ).toEqual([
          {
            kind: "material",
            material_id: null,
            material_page_id: null,
            section_id: null,
            anchor_label: "hal. 1",
            excerpt: null,
            question_version_id: FIXTURE.version(1),
          },
        ]);
        expect(
          (await run(`select id from questions where id = '${FIXTURE.question(1)}'`))
            .rows,
        ).toEqual([{ id: FIXTURE.question(1) }]);
        expect(
          (await run(`select id from materials where id = '${FIXTURE.material(2)}'`))
            .rows,
        ).toHaveLength(1);
      } finally {
        await fresh.client.close();
      }
    },
    DB_TEST_TIMEOUT,
  );
});

describe("folder trash", () => {
  it("refuses a folder that still holds materials or subfolders", async () => {
    const folder = await seedFolder(database, { ownerId: USER_A });
    const material = await seedMaterial(database, { ownerId: USER_A, folderId: folder });
    expect(
      await trashFolder(db(), { ownerId: USER_A, folderId: folder, now: NOW }),
    ).toEqual({
      ok: false,
      error: "notEmpty",
    });
    await trashMaterial(db(), { ownerId: USER_A, materialId: material, now: NOW });
    const child = await seedFolder(database, { ownerId: USER_A, parentId: folder });
    expect(
      await trashFolder(db(), { ownerId: USER_A, folderId: folder, now: NOW }),
    ).toEqual({
      ok: false,
      error: "notEmpty",
    });
    expect(
      await trashFolder(db(), { ownerId: USER_A, folderId: child, now: NOW }),
    ).toEqual({
      ok: true,
      data: undefined,
    });
    // Trashed materials and subfolders do not count.
    expect(
      await trashFolder(db(), { ownerId: USER_A, folderId: folder, now: NOW }),
    ).toEqual({
      ok: true,
      data: undefined,
    });
    expect(
      await trashFolder(db(), { ownerId: USER_B, folderId: folder, now: NOW }),
    ).toEqual({
      ok: false,
      error: "notFound",
    });
  });

  it("restores a folder, at the top level when its parent is gone", async () => {
    const parent = await seedFolder(database, { ownerId: USER_A, name: "Induk" });
    const child = await seedFolder(database, {
      ownerId: USER_A,
      name: "Anak",
      parentId: parent,
    });
    await trashFolder(db(), { ownerId: USER_A, folderId: child, now: NOW });
    await trashFolder(db(), { ownerId: USER_A, folderId: parent, now: NOW });
    expect(await restoreFolder(db(), { ownerId: USER_B, folderId: child })).toEqual({
      ok: false,
      error: "notFound",
    });
    expect(await restoreFolder(db(), { ownerId: USER_A, folderId: child })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await folderRow(child)).toMatchObject({ deletedAt: null, parentId: null });
    expect(await restoreFolder(db(), { ownerId: USER_A, folderId: child })).toEqual({
      ok: false,
      error: "notInTrash",
    });
  });

  it("deletes a folder for good without taking a trashed subfolder or material early", async () => {
    const store = listingStore();
    const parent = await seedFolder(database, { ownerId: USER_A });
    const child = await seedFolder(database, { ownerId: USER_A, parentId: parent });
    const material = await seedMaterial(database, { ownerId: USER_A, folderId: parent });
    await trashMaterial(db(), { ownerId: USER_A, materialId: material, now: NOW });
    await trashFolder(db(), { ownerId: USER_A, folderId: child, now: NOW });
    await trashFolder(db(), { ownerId: USER_A, folderId: parent, now: NOW });

    expect(
      await deleteFolderPermanently(db(), {
        ownerId: USER_B,
        folderId: parent,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "notFound" });
    expect(
      await deleteFolderPermanently(db(), {
        ownerId: USER_A,
        folderId: parent,
        now: NOW,
      }),
    ).toEqual({ ok: true, data: { subfolders: 1, materials: 1 } });
    expect(await folderRow(parent)).toBeUndefined();
    expect(await folderRow(child)).toMatchObject({ parentId: null });
    expect((await folderRow(child))?.deletedAt).toEqual(NOW);
    expect(await materialRow(material)).toMatchObject({ folderId: null });
    expect((await materialRow(material))?.deletedAt).toEqual(NOW);
    expect(await database.db.select().from(deletionLog)).toMatchObject([
      {
        entity: "folder",
        entityId: parent,
        counts: { folders: 1, subfolders: 1, materials: 1 },
      },
    ]);
    expect(store.keys()).toEqual([]);
  });

  it("purges expired folders and lists the owner's trashed ones", async () => {
    const old = await seedFolder(database, { ownerId: USER_A, name: "Lama" });
    const recent = await seedFolder(database, { ownerId: USER_A, name: "Baru" });
    await trashFolder(db(), { ownerId: USER_A, folderId: old, now: NOW });
    await trashFolder(db(), {
      ownerId: USER_A,
      folderId: recent,
      now: new Date(NOW.getTime() + 2 * DAY_MS),
    });
    expect(
      (await listTrashedFolders(db(), { ownerId: USER_A, now: NOW })).map((f) => f.name),
    ).toEqual(["Baru", "Lama"]);
    expect(await listTrashedFolders(db(), { ownerId: USER_B, now: NOW })).toEqual([]);
    expect(
      await purgeExpiredFolders(db(), new Date(NOW.getTime() + 30 * DAY_MS)),
    ).toEqual({ purged: 1, failed: 0 });
    expect(await folderRow(old)).toBeUndefined();
    expect(await folderRow(recent)).toBeDefined();
  });
});
