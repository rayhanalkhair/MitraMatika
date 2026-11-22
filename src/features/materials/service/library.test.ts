import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser } from "@/lib/db/client";
import { folders, materials, materialUploads } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { seedFolder, seedMaterial, seedPages } from "../fixtures/library";
import { materialQuerySchema, type MaterialQuery } from "../schema/library";
import { STORAGE_CAP_BYTES } from "../schema/upload";
import {
  countMaterials,
  createFolder,
  folderFailureOf,
  getMaterialDetail,
  listFolders,
  listMaterials,
  moveFolder,
  moveMaterial,
  renameFolder,
  storageUsage,
} from "./library";
import type { MaterialDb } from "./upload";

let database: TestDatabase;
const NOW = new Date("2026-11-20T03:00:00.000Z");

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
});

/** Runs `fn` as the teacher (RLS on), like the pages and actions do. */
function asUser<T>(userId: string, fn: (db: MaterialDb) => Promise<T>): Promise<T> {
  return runAsUser(database.db, userId, (tx) => fn(tx as unknown as MaterialDb));
}
const query = (raw: Record<string, unknown> = {}): MaterialQuery =>
  materialQuerySchema.parse(raw);
const list = (ownerId: string, raw: Record<string, unknown> = {}) =>
  asUser(ownerId, (db) => listMaterials(db, { ownerId, query: query(raw) }));
const titles = async (ownerId: string, raw: Record<string, unknown> = {}) =>
  (await list(ownerId, raw)).items.map((item) => item.title);

describe("materialQuerySchema", () => {
  it("drops what does not parse and keeps the rest", () => {
    expect(
      query({
        grade: "8",
        year: "2026/2027",
        status: "ready",
        q: "  pecahan  ",
        page: "2",
        folder: "not-a-uuid",
      }),
    ).toEqual({ grade: 8, year: "2026/2027", status: "ready", q: "pecahan", page: 2 });
    expect(query({ grade: "10", year: "2026/2028", status: "lost", page: "-3" })).toEqual(
      {
        page: 1,
      },
    );
  });
});

describe("listMaterials", () => {
  it("lists the owner's materials newest first, without trashed ones or another teacher's", async () => {
    await seedMaterial(database, {
      ownerId: USER_A,
      title: "Lama",
      createdAt: new Date("2026-11-01T00:00:00Z"),
    });
    await seedMaterial(database, {
      ownerId: USER_A,
      title: "Baru",
      createdAt: new Date("2026-11-10T00:00:00Z"),
    });
    await seedMaterial(database, {
      ownerId: USER_A,
      title: "Di sampah",
      deletedAt: NOW,
      purgeAfter: NOW,
    });
    await seedMaterial(database, { ownerId: USER_B, title: "Milik B" });

    expect(await titles(USER_A)).toEqual(["Baru", "Lama"]);
    expect(await titles(USER_B)).toEqual(["Milik B"]);
    expect(await asUser(USER_A, (db) => countMaterials(db, { ownerId: USER_A }))).toBe(2);
  });

  it("filters by folder, grade, academic year and status", async () => {
    const folder = await seedFolder(database, { ownerId: USER_A, name: "Kelas 8" });
    await seedMaterial(database, {
      ownerId: USER_A,
      title: "Di folder",
      folderId: folder,
      grade: 8,
      academicYear: "2026/2027",
      status: "ready",
    });
    await seedMaterial(database, {
      ownerId: USER_A,
      title: "Kelas 7",
      grade: 7,
      academicYear: "2025/2026",
      status: "needs_review",
    });
    await seedMaterial(database, { ownerId: USER_A, title: "Gagal", status: "failed" });

    expect(await titles(USER_A, { folder })).toEqual(["Di folder"]);
    expect(await titles(USER_A, { grade: "7" })).toEqual(["Kelas 7"]);
    expect(await titles(USER_A, { year: "2026/2027" })).toEqual(["Di folder"]);
    expect(await titles(USER_A, { status: "failed" })).toEqual(["Gagal"]);
    expect(await titles(USER_A, { status: "needs_review", grade: "8" })).toEqual([]);
    // Another teacher's folder id shows nothing (owner-scoped, RLS on).
    expect(await titles(USER_B, { folder })).toEqual([]);
  });

  it("offers the academic years the owner uses as a filter", async () => {
    await seedMaterial(database, { ownerId: USER_A, academicYear: "2026/2027" });
    await seedMaterial(database, { ownerId: USER_A, academicYear: "2025/2026" });
    await seedMaterial(database, { ownerId: USER_A, academicYear: "2026/2027" });
    await seedMaterial(database, { ownerId: USER_B, academicYear: "2024/2025" });
    expect((await list(USER_A)).years).toEqual(["2026/2027", "2025/2026"]);
  });

  it("searches the title and the extracted page text (stemmed and literal), and says where", async () => {
    const book = await seedMaterial(database, { ownerId: USER_A, title: "Buku Siswa" });
    await seedPages(database, {
      ownerId: USER_A,
      materialId: book,
      texts: [
        "Kata pengantar",
        "Bab 2 membahas persamaan linear dua variabel",
        "Teorema Pythagoras",
      ],
    });
    await seedMaterial(database, { ownerId: USER_A, title: "Modul Pecahan" });
    const other = await seedMaterial(database, { ownerId: USER_B, title: "Buku B" });
    await seedPages(database, {
      ownerId: USER_B,
      materialId: other,
      texts: ["persamaan kuadrat"],
    });

    expect(await titles(USER_A, { q: "pecahan" })).toEqual(["Modul Pecahan"]);
    // "persamaan" stems to "sama" in the Indonesian configuration: "menyamakan"-style forms match.
    const found = await list(USER_A, { q: "persamaan" });
    expect(found.items.map((item) => item.title)).toEqual(["Buku Siswa"]);
    expect(found.items[0].matchPage).toBe(2);
    expect(await titles(USER_A, { q: "pythagoras" })).toEqual(["Buku Siswa"]);
    // A title match has no page to point at.
    expect((await list(USER_A, { q: "modul" })).items[0].matchPage).toBeNull();
    // Trashed materials are never found.
    await database.db
      .update(materials)
      .set({ deletedAt: NOW, purgeAfter: NOW })
      .where(eq(materials.id, book));
    expect(await titles(USER_A, { q: "pythagoras" })).toEqual([]);
  });

  it("treats hostile search text as plain words", async () => {
    await seedMaterial(database, { ownerId: USER_A, title: "100% siap_pakai" });
    await seedMaterial(database, { ownerId: USER_A, title: "Lainnya" });
    for (const hostile of [
      "'; drop table materials; --",
      "a & | ! ( ) : * <-> \\",
      "%",
      "_",
      "$$\\input{/etc/passwd}$$",
      "<script>alert(1)</script>",
      "'",
      "\u0000",
    ]) {
      await expect(list(USER_A, { q: hostile })).resolves.toBeDefined();
    }
    // LIKE wildcards match only themselves.
    expect(await titles(USER_A, { q: "%" })).toEqual(["100% siap_pakai"]);
    expect(await titles(USER_A, { q: "_" })).toEqual(["100% siap_pakai"]);
    expect((await database.db.select().from(materials)).length).toBe(2);
  });

  it("pages by 20 and clamps a page past the end", async () => {
    for (let i = 0; i < 23; i += 1) {
      await seedMaterial(database, {
        ownerId: USER_A,
        title: `Materi ${String(i).padStart(2, "0")}`,
        createdAt: new Date(NOW.getTime() - i * 60_000),
      });
    }
    const first = await list(USER_A);
    expect(first.total).toBe(23);
    expect(first.pageCount).toBe(2);
    expect(first.items).toHaveLength(20);
    const second = await list(USER_A, { page: "9" });
    expect(second.page).toBe(2);
    expect(second.items.map((item) => item.title)).toEqual([
      "Materi 20",
      "Materi 21",
      "Materi 22",
    ]);
  });

  it("names the folder and whether the structure was confirmed", async () => {
    const folder = await seedFolder(database, { ownerId: USER_A, name: "Semester 1" });
    const id = await seedMaterial(database, { ownerId: USER_A, folderId: folder });
    await database.db
      .update(materials)
      .set({ metadataConfirmedAt: NOW })
      .where(eq(materials.id, id));
    const [item] = (await list(USER_A)).items;
    expect(item).toMatchObject({
      id,
      folderId: folder,
      folderName: "Semester 1",
      structureConfirmed: true,
      status: "ready",
      kind: "pdf",
      pageCount: 3,
    });
  });
});

describe("storageUsage", () => {
  it("counts stored materials (trashed too) and live reservations, never another teacher's", async () => {
    await seedMaterial(database, { ownerId: USER_A, sizeBytes: 300 });
    await seedMaterial(database, {
      ownerId: USER_A,
      sizeBytes: 200,
      deletedAt: NOW,
      purgeAfter: NOW,
    });
    await seedMaterial(database, { ownerId: USER_B, sizeBytes: 9999 });
    await database.db.insert(materialUploads).values([
      {
        ownerId: USER_A,
        objectKey: `uploads/${USER_A}/${crypto.randomUUID()}/source.pdf`,
        kind: "pdf",
        mime: "application/pdf",
        sizeBytes: 50,
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
      {
        ownerId: USER_A,
        objectKey: `uploads/${USER_A}/${crypto.randomUUID()}/source.pdf`,
        kind: "pdf",
        mime: "application/pdf",
        sizeBytes: 7000,
        expiresAt: new Date(NOW.getTime() - 60_000),
      },
    ]);
    const usage = await asUser(USER_A, (db) =>
      storageUsage(db, { ownerId: USER_A, now: NOW }),
    );
    expect(usage).toEqual({ usedBytes: 550, capBytes: STORAGE_CAP_BYTES });
    expect(STORAGE_CAP_BYTES).toBe(1024 * 1024 * 1024);
  });

  it("counts the page images OCR keeps for the teacher's materials", async () => {
    const id = await seedMaterial(database, { ownerId: USER_A, sizeBytes: 300 });
    await seedPages(database, { ownerId: USER_A, materialId: id, texts: ["a", "b"] });
    await database.db.execute(
      sql`update material_pages set image_bytes = 1000 where material_id = ${id}`,
    );
    const usage = await asUser(USER_A, (db) =>
      storageUsage(db, { ownerId: USER_A, now: NOW }),
    );
    expect(usage.usedBytes).toBe(2_300);
  });
});

describe("folders", () => {
  it("creates, lists with counts, renames and nests one level", async () => {
    const parent = await asUser(USER_A, (db) =>
      createFolder(db, { ownerId: USER_A, name: "  Kelas 8  " }),
    );
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;
    const child = await asUser(USER_A, (db) =>
      createFolder(db, { ownerId: USER_A, name: "Bab 1", parentId: parent.data.id }),
    );
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    await seedMaterial(database, { ownerId: USER_A, folderId: child.data.id });
    await seedMaterial(database, {
      ownerId: USER_A,
      folderId: child.data.id,
      deletedAt: NOW,
      purgeAfter: NOW,
    });

    expect(
      await asUser(USER_A, (db) =>
        renameFolder(db, {
          ownerId: USER_A,
          folderId: parent.data.id,
          name: "Kelas VIII",
        }),
      ),
    ).toEqual({ ok: true, data: undefined });
    const listed = await asUser(USER_A, (db) => listFolders(db, { ownerId: USER_A }));
    expect(listed).toEqual([
      { id: child.data.id, name: "Bab 1", parentId: parent.data.id, materialCount: 1 },
      { id: parent.data.id, name: "Kelas VIII", parentId: null, materialCount: 0 },
    ]);

    // A third level is refused by the database and reported as `nesting`.
    expect(
      await asUser(USER_A, (db) =>
        createFolder(db, {
          ownerId: USER_A,
          name: "Terlalu dalam",
          parentId: child.data.id,
        }),
      ),
    ).toEqual({ ok: false, error: "nesting" });
    // A folder with subfolders cannot go inside another folder.
    const other = await seedFolder(database, { ownerId: USER_A, name: "Lain" });
    expect(
      await asUser(USER_A, (db) =>
        moveFolder(db, { ownerId: USER_A, folderId: parent.data.id, parentId: other }),
      ),
    ).toEqual({ ok: false, error: "nesting" });
    // Into itself.
    expect(
      await asUser(USER_A, (db) =>
        moveFolder(db, { ownerId: USER_A, folderId: other, parentId: other }),
      ),
    ).toEqual({ ok: false, error: "nesting" });
    // A leaf moves into a top-level folder and back out.
    expect(
      await asUser(USER_A, (db) =>
        moveFolder(db, { ownerId: USER_A, folderId: other, parentId: parent.data.id }),
      ),
    ).toEqual({ ok: true, data: undefined });
    expect(
      await asUser(USER_A, (db) =>
        moveFolder(db, { ownerId: USER_A, folderId: other, parentId: null }),
      ),
    ).toEqual({ ok: true, data: undefined });
  });

  it("says when only a subfolder in the trash keeps a folder from moving", async () => {
    const parent = await seedFolder(database, { ownerId: USER_A, name: "Induk" });
    await seedFolder(database, {
      ownerId: USER_A,
      name: "Anak di sampah",
      parentId: parent,
      deletedAt: NOW,
      purgeAfter: NOW,
    });
    const target = await seedFolder(database, { ownerId: USER_A, name: "Tujuan" });
    expect(
      await asUser(USER_A, (db) =>
        moveFolder(db, { ownerId: USER_A, folderId: parent, parentId: target }),
      ),
    ).toEqual({ ok: false, error: "trashedSubfolders" });
    // A live subfolder is still the plain nesting refusal.
    await seedFolder(database, { ownerId: USER_A, name: "Anak", parentId: parent });
    expect(
      await asUser(USER_A, (db) =>
        moveFolder(db, { ownerId: USER_A, folderId: parent, parentId: target }),
      ),
    ).toEqual({ ok: false, error: "nesting" });
  });

  it("refuses empty or long names", async () => {
    for (const name of ["", "   ", "x".repeat(81)]) {
      expect(
        await asUser(USER_A, (db) => createFolder(db, { ownerId: USER_A, name })),
      ).toEqual({ ok: false, error: "name" });
    }
  });

  it("never reaches another teacher's folder, nor a trashed one", async () => {
    const mine = await seedFolder(database, { ownerId: USER_A, name: "Punya A" });
    const trashed = await seedFolder(database, {
      ownerId: USER_A,
      name: "Sampah",
      deletedAt: NOW,
      purgeAfter: NOW,
    });
    const theirs = await seedFolder(database, { ownerId: USER_B, name: "Punya B" });

    expect(
      await asUser(USER_B, (db) =>
        renameFolder(db, { ownerId: USER_B, folderId: mine, name: "Diambil" }),
      ),
    ).toEqual({ ok: false, error: "notFound" });
    expect(
      await asUser(USER_B, (db) =>
        createFolder(db, { ownerId: USER_B, name: "Anak", parentId: mine }),
      ),
    ).toEqual({ ok: false, error: "parent" });
    expect(
      await asUser(USER_B, (db) =>
        moveFolder(db, { ownerId: USER_B, folderId: theirs, parentId: mine }),
      ),
    ).toEqual({ ok: false, error: "parent" });
    expect(
      await asUser(USER_A, (db) =>
        createFolder(db, { ownerId: USER_A, name: "Anak", parentId: trashed }),
      ),
    ).toEqual({ ok: false, error: "parent" });
    expect(
      await asUser(USER_A, (db) =>
        renameFolder(db, { ownerId: USER_A, folderId: trashed, name: "Baru" }),
      ),
    ).toEqual({ ok: false, error: "notFound" });
    expect(await asUser(USER_B, (db) => listFolders(db, { ownerId: USER_B }))).toEqual([
      { id: theirs, name: "Punya B", parentId: null, materialCount: 0 },
    ]);
    const [row] = await database.db.select().from(folders).where(eq(folders.id, mine));
    expect(row.name).toBe("Punya A");
  });

  it("maps a deadlock to retry and the nesting rule to nesting; anything else is rethrown", () => {
    const pg = (code: string, constraint?: string) =>
      Object.assign(new Error("query failed"), {
        cause: Object.assign(new Error("pg"), { code, constraint }),
      });
    expect(folderFailureOf(pg("40P01"))).toBe("retry");
    expect(folderFailureOf(pg("40001"))).toBe("retry");
    expect(folderFailureOf(pg("23514", "folders_one_level"))).toBe("nesting");
    expect(folderFailureOf(pg("23514", "folders_not_own_parent_check"))).toBe("nesting");
    expect(folderFailureOf(pg("23514", "folders_name_check"))).toBe("name");
    expect(folderFailureOf(pg("23503"))).toBeNull();
    expect(folderFailureOf(new Error("boom"))).toBeNull();
  });

  it("returns retry when the database reports a deadlock during a move", async () => {
    const folder = await seedFolder(database, { ownerId: USER_A, name: "A" });
    const target = await seedFolder(database, { ownerId: USER_A, name: "B" });
    // A database whose write fails as a deadlock victim's would (wrapped, as Drizzle wraps it).
    const deadlocked = await asUser(USER_A, async (db) => {
      const failing = new Proxy(db, {
        get(target_, key, receiver) {
          if (key === "transaction") {
            return () =>
              Promise.reject(
                Object.assign(new Error("Failed query"), {
                  cause: Object.assign(new Error("deadlock detected"), {
                    code: "40P01",
                  }),
                }),
              );
          }
          const value: unknown = Reflect.get(target_, key, receiver);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target_)
            : value;
        },
      });
      return moveFolder(failing, { ownerId: USER_A, folderId: folder, parentId: target });
    });
    expect(deadlocked).toEqual({ ok: false, error: "retry" });
  });
});

describe("moveMaterial", () => {
  it("moves the owner's material into an own folder or back to the top", async () => {
    const folder = await seedFolder(database, { ownerId: USER_A });
    const id = await seedMaterial(database, { ownerId: USER_A });
    expect(
      await asUser(USER_A, (db) =>
        moveMaterial(db, { ownerId: USER_A, materialId: id, folderId: folder }),
      ),
    ).toEqual({ ok: true, data: undefined });
    expect(
      (await database.db.select().from(materials).where(eq(materials.id, id)))[0]
        .folderId,
    ).toBe(folder);
    expect(
      await asUser(USER_A, (db) =>
        moveMaterial(db, { ownerId: USER_A, materialId: id, folderId: null }),
      ),
    ).toEqual({ ok: true, data: undefined });
  });

  it("refuses another teacher's material or folder and trashed ones", async () => {
    const mine = await seedMaterial(database, { ownerId: USER_A });
    const theirFolder = await seedFolder(database, { ownerId: USER_B });
    const trashedFolder = await seedFolder(database, {
      ownerId: USER_A,
      deletedAt: NOW,
      purgeAfter: NOW,
    });
    const trashedMaterial = await seedMaterial(database, {
      ownerId: USER_A,
      deletedAt: NOW,
      purgeAfter: NOW,
    });
    expect(
      await asUser(USER_B, (db) =>
        moveMaterial(db, { ownerId: USER_B, materialId: mine, folderId: theirFolder }),
      ),
    ).toEqual({ ok: false, error: "notFound" });
    expect(
      await asUser(USER_A, (db) =>
        moveMaterial(db, { ownerId: USER_A, materialId: mine, folderId: theirFolder }),
      ),
    ).toEqual({ ok: false, error: "folder" });
    expect(
      await asUser(USER_A, (db) =>
        moveMaterial(db, { ownerId: USER_A, materialId: mine, folderId: trashedFolder }),
      ),
    ).toEqual({ ok: false, error: "folder" });
    expect(
      await asUser(USER_A, (db) =>
        moveMaterial(db, {
          ownerId: USER_A,
          materialId: trashedMaterial,
          folderId: null,
        }),
      ),
    ).toEqual({ ok: false, error: "notFound" });
  });
});

describe("getMaterialDetail", () => {
  it("returns the owner's material with page counts by confidence; null for others and the trash", async () => {
    const folder = await seedFolder(database, { ownerId: USER_A, name: "Kelas 8" });
    const id = await seedMaterial(database, {
      ownerId: USER_A,
      title: "Buku Guru",
      folderId: folder,
      grade: 8,
      academicYear: "2026/2027",
      status: "needs_review",
    });
    await seedPages(database, {
      ownerId: USER_A,
      materialId: id,
      texts: ["a", "b", "c"],
    });
    await database.db.execute(
      sql`update material_pages set confidence = 'low', flags = '["low_text"]'::jsonb where page_no = 3`,
    );
    const detail = await asUser(USER_A, (db) =>
      getMaterialDetail(db, { ownerId: USER_A, materialId: id }),
    );
    expect(detail).toMatchObject({
      id,
      title: "Buku Guru",
      folderId: folder,
      folderName: "Kelas 8",
      grade: 8,
      academicYear: "2026/2027",
      status: "needs_review",
      pages: { total: 3, high: 2, medium: 0, low: 1 },
      flaggedPages: [3],
      proposal: null,
      sections: [],
      metadataConfirmedAt: null,
    });
    expect(
      await asUser(USER_B, (db) =>
        getMaterialDetail(db, { ownerId: USER_B, materialId: id }),
      ),
    ).toBeNull();
    expect(
      await asUser(USER_A, (db) =>
        getMaterialDetail(db, { ownerId: USER_A, materialId: "not-a-uuid" }),
      ),
    ).toBeNull();
    await database.db
      .update(materials)
      .set({ deletedAt: NOW, purgeAfter: NOW })
      .where(eq(materials.id, id));
    expect(
      await asUser(USER_A, (db) =>
        getMaterialDetail(db, { ownerId: USER_A, materialId: id }),
      ),
    ).toBeNull();
  });
});
