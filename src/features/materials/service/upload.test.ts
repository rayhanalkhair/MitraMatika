import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  folders,
  jobs,
  materialPages,
  materials,
  materialUploads,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { contains, jpegWithExif } from "@/lib/images/metadata-fixtures";
import { MAX_DEV_UPLOAD_BYTES } from "@/lib/storage/dev-upload";
import { createMemoryStore, type MemoryStore } from "@/lib/storage/memory";
import type { ObjectStore } from "@/lib/storage/types";
import {
  html,
  makeDoc,
  makeDocx,
  makeImage,
  makePdf,
  makeZip,
  makeZipBombDocx,
} from "../test-support";
import {
  INGEST_MATERIAL_JOB,
  MAX_MATERIAL_BYTES,
  MAX_PENDING_UPLOADS,
  STORAGE_CAP_BYTES,
} from "../schema/upload";
import { runBoundedWorker } from "./bounded-worker";
import { cancelUpload, finalizeUpload, startUpload, type MaterialDb } from "./upload";

let database: TestDatabase;
let store: MemoryStore;
const db = () => database.db as unknown as MaterialDb;
const NOW = new Date("2026-11-20T03:00:00.000Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const MB = 1024 * 1024;

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
  store = createMemoryStore({ uploadPath: "/api/dev/upload" });
});

const ticketCount = async () => (await database.db.select().from(materialUploads)).length;
const materialCount = async () => (await database.db.select().from(materials)).length;
const jobCount = async () => (await database.db.select().from(jobs)).length;

async function start(
  ownerId: string,
  fileName: string,
  size: number,
  declaredType = "",
  now = NOW,
) {
  return startUpload(db(), store, { ownerId, fileName, declaredType, size, now });
}

/** Starts an upload of `bytes` named `fileName` and puts the bytes where the URL points. */
async function upload(ownerId: string, fileName: string, bytes: Uint8Array) {
  const started = await start(ownerId, fileName, bytes.length);
  if (!started.ok) throw new Error(`startUpload: ${started.error}`);
  await store.put(started.data.objectKey, bytes, started.data.contentType);
  return started.data;
}

/** Stored materials of `ownerId` totalling `bytes` (rows only; no object needed for the cap). */
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

describe("startUpload", () => {
  it(
    "signs a PUT for the exact size under an id-only key and records the reservation",
    async () => {
      const result = await start(USER_A, "Buku Guru Matematika (kelas 7).PDF", 2048);
      if (!result.ok) throw new Error(result.error);
      const { objectKey, uploadUrl, contentType } = result.data;
      expect(objectKey).toMatch(
        new RegExp(`^uploads/${USER_A}/[0-9a-f-]{36}/source\\.pdf$`),
      );
      expect(contentType).toBe("application/pdf");
      const url = new URL(uploadUrl, "http://localhost");
      expect(Number(url.searchParams.get("expires"))).toBeLessThanOrEqual(300);
      expect(url.searchParams.get("length")).toBe("2048");
      expect(url.searchParams.get("type")).toBe("application/pdf");
      const [ticket] = await database.db.select().from(materialUploads);
      expect(ticket).toMatchObject({
        ownerId: USER_A,
        objectKey,
        kind: "pdf",
        sizeBytes: 2048,
      });
      expect(ticket.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "maps .jpeg to .jpg and accepts PNG and DOCX",
    async () => {
      for (const [name, ext] of [
        ["foto.jpeg", "jpg"],
        ["foto.JPG", "jpg"],
        ["papan.png", "png"],
        ["modul.docx", "docx"],
      ]) {
        const result = await start(USER_A, name, 10);
        expect(result.ok && result.data.objectKey.endsWith(`/source.${ext}`), name).toBe(
          true,
        );
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses an old .doc with its own reason, by name or by declared type",
    async () => {
      expect(await start(USER_A, "modul.doc", 10)).toEqual({ ok: false, error: "doc" });
      expect(await start(USER_A, "modul", 10, "application/msword")).toEqual({
        ok: false,
        error: "doc",
      });
      expect(await ticketCount()).toBe(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses other types and a declared type that contradicts the name",
    async () => {
      for (const [name, type] of [
        ["setup.exe", ""],
        ["catatan.txt", "text/plain"],
        ["tanpa-ekstensi", ""],
        ["foto.heic", "image/heic"],
        ["a.constructor", ""],
        ["a.__proto__", ""],
        ["buku.pdf", "image/png"],
      ]) {
        expect(await start(USER_A, name, 10, type), name).toEqual({
          ok: false,
          error: "type",
        });
      }
      expect(await ticketCount()).toBe(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "accepts exactly 25 MB and refuses 26 MB, an empty file and a fractional size",
    async () => {
      expect(MAX_MATERIAL_BYTES).toBe(25 * 1024 * 1024);
      // The dev/e2e PUT stand-in must accept every upload the app signs.
      expect(MAX_DEV_UPLOAD_BYTES).toBeGreaterThan(MAX_MATERIAL_BYTES);
      expect((await start(USER_A, "a.pdf", MAX_MATERIAL_BYTES)).ok).toBe(true);
      for (const size of [26 * MB, MAX_MATERIAL_BYTES + 1, 50 * MB, 0, -1, 1.5]) {
        expect(await start(USER_A, "a.pdf", size), String(size)).toEqual({
          ok: false,
          error: "size",
        });
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "holds the 300 MB storage cap over stored materials plus pending uploads",
    async () => {
      expect(STORAGE_CAP_BYTES).toBe(300 * 1024 * 1024);
      await seedStored(USER_A, STORAGE_CAP_BYTES - 10 * MB);
      expect(await start(USER_A, "a.pdf", 10 * MB + 1)).toEqual({
        ok: false,
        error: "quota",
      });
      expect((await start(USER_A, "a.pdf", 10 * MB)).ok).toBe(true);
      // The pending 10 MB now fills the cap.
      expect(await start(USER_A, "b.pdf", 1)).toEqual({ ok: false, error: "quota" });
      // Another teacher's usage is their own.
      expect((await start(USER_B, "b.pdf", 10 * MB)).ok).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "counts OCR page images toward the 300 MB cap",
    async () => {
      await seedStored(USER_A, STORAGE_CAP_BYTES - 10 * MB);
      const [material] = await database.db.select().from(materials);
      await database.db.insert(materialPages).values({
        ownerId: USER_A,
        materialId: material.id,
        pageNo: 1,
        textMd: "",
        imageBytes: 5 * MB,
      });
      expect(await start(USER_A, "a.pdf", 5 * MB + 1)).toEqual({
        ok: false,
        error: "quota",
      });
      expect((await start(USER_A, "a.pdf", 5 * MB)).ok).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses every new upload of a teacher already above the new cap, and only theirs",
    async () => {
      // Allowed before the cap dropped from 1 GB to 300 MB.
      await seedStored(USER_A, 400 * MB);
      for (const size of [1, 10 * MB, MAX_MATERIAL_BYTES]) {
        expect(await start(USER_A, "a.pdf", size), String(size)).toEqual({
          ok: false,
          error: "quota",
        });
      }
      expect(await ticketCount()).toBe(0);
      // Another teacher is unaffected.
      expect((await start(USER_B, "b.pdf", MAX_MATERIAL_BYTES)).ok).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "counts trashed materials until they are purged",
    async () => {
      await seedStored(USER_A, STORAGE_CAP_BYTES);
      await database.db
        .update(materials)
        .set({ deletedAt: NOW, purgeAfter: later(60 * 24 * 30) });
      expect(await start(USER_A, "a.pdf", 1)).toEqual({ ok: false, error: "quota" });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "frees an expired reservation and deletes its object on the owner's next start",
    async () => {
      await seedStored(USER_A, STORAGE_CAP_BYTES - 10 * MB);
      const first = await start(USER_A, "a.pdf", 10 * MB);
      if (!first.ok) throw new Error(first.error);
      await store.put(first.data.objectKey, new Uint8Array(4), "application/pdf");
      const second = await start(USER_A, "b.pdf", 10 * MB, "", later(61));
      expect(second.ok).toBe(true);
      expect(await store.get(first.data.objectKey)).toBeNull();
      const keys = (await database.db.select().from(materialUploads)).map(
        (row) => row.objectKey,
      );
      expect(keys).not.toContain(first.data.objectKey);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    `allows at most ${String(MAX_PENDING_UPLOADS)} uploads in flight per teacher`,
    async () => {
      for (let i = 0; i < MAX_PENDING_UPLOADS; i += 1) {
        expect((await start(USER_A, `${String(i)}.pdf`, 10)).ok).toBe(true);
      }
      expect(await start(USER_A, "lagi.pdf", 10)).toEqual({
        ok: false,
        error: "pending",
      });
      expect((await start(USER_B, "b.pdf", 10)).ok).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("finalizeUpload", () => {
  it(
    "answers busy and keeps the upload when another parse holds the process's slot (R29)",
    async () => {
      const bytes = makePdf(2);
      const { objectKey } = await upload(USER_A, "buku.pdf", bytes);
      // Another parse (here a worker that spins until its 1.5 s limit) holds the slot.
      const other = runBoundedWorker(
        new URL("../fixtures/spin.worker.mjs", import.meta.url),
        {
          ownerId: "another-teacher",
          data: {},
          timeoutMs: 1_500,
          resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
        },
      );
      const refused = await finalizeUpload(db(), store, {
        ownerId: USER_A,
        objectKey,
        title: "Buku",
        now: later(2),
        parseWaitMs: 50,
      });
      expect(refused).toEqual({ ok: false, error: "busy" });
      expect(await store.get(objectKey)).toEqual(bytes);
      expect(await ticketCount()).toBe(1);
      await other;
      const done = await finalizeUpload(db(), store, {
        ownerId: USER_A,
        objectKey,
        title: "Buku",
        now: later(3),
      });
      expect(done.ok).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "creates the material from the stored bytes and queues its ingestion",
    async () => {
      const bytes = makePdf(3);
      const { objectKey } = await upload(USER_A, "buku.pdf", bytes);
      const result = await finalizeUpload(db(), store, {
        ownerId: USER_A,
        objectKey,
        title: "  Buku guru kelas 7  ",
        now: later(2),
      });
      if (!result.ok) throw new Error(result.error);
      const { materialId } = result.data;
      expect(objectKey).toBe(`uploads/${USER_A}/${materialId}/source.pdf`);
      const finalKey = `materials/${USER_A}/${materialId}/source.pdf`;

      const [row] = await database.db
        .select()
        .from(materials)
        .where(eq(materials.id, materialId));
      expect(row).toMatchObject({
        ownerId: USER_A,
        title: "Buku guru kelas 7",
        kind: "pdf",
        mime: "application/pdf",
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        objectKey: finalKey,
        pageCount: 3,
        status: "uploaded",
        folderId: null,
      });
      const [job] = await database.db.select().from(jobs);
      expect(job).toMatchObject({
        ownerId: USER_A,
        type: INGEST_MATERIAL_JOB,
        status: "queued",
        payload: { materialId },
      });
      expect(await ticketCount()).toBe(0);
      // The validated bytes live under a key no URL was signed for; the staging object is gone.
      expect(await store.get(finalKey)).toEqual(bytes);
      expect(await store.get(objectKey)).toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "keeps an image material without its metadata (Exif GPS) and hashes what it keeps",
    async () => {
      const bytes = jpegWithExif();
      const { objectKey } = await upload(USER_A, "foto.jpg", bytes);
      const result = await finalizeUpload(db(), store, {
        ownerId: USER_A,
        objectKey,
        title: "Foto",
        now: later(2),
      });
      if (!result.ok) throw new Error(result.error);
      const [row] = await database.db
        .select()
        .from(materials)
        .where(eq(materials.id, result.data.materialId));
      const kept = await store.get(row.objectKey);
      expect(kept).not.toBeNull();
      if (!kept) return;
      for (const marker of ["GPS", "Exif", "xmpmeta", "rumah"]) {
        expect(contains(kept, marker), marker).toBe(false);
      }
      expect(row.sizeBytes).toBe(kept.length);
      expect(row.sha256).toBe(createHash("sha256").update(kept).digest("hex"));
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "files the material in the teacher's own folder, never another teacher's",
    async () => {
      const [mine] = await database.db
        .insert(folders)
        .values({ ownerId: USER_A, name: "Kelas 7" })
        .returning();
      const [theirs] = await database.db
        .insert(folders)
        .values({ ownerId: USER_B, name: "Kelas 8" })
        .returning();
      const { objectKey } = await upload(USER_A, "foto.png", makeImage("png"));
      expect(
        await finalizeUpload(db(), store, {
          ownerId: USER_A,
          objectKey,
          title: "Foto",
          folderId: theirs.id,
          now: NOW,
        }),
      ).toEqual({ ok: false, error: "folder" });
      // An input mistake keeps the upload, so the teacher can fix it and finalise again.
      expect(await store.get(objectKey)).not.toBeNull();
      const result = await finalizeUpload(db(), store, {
        ownerId: USER_A,
        objectKey,
        title: "Foto",
        folderId: mine.id,
        now: NOW,
      });
      expect(result.ok).toBe(true);
      const [row] = await database.db.select().from(materials);
      expect(row).toMatchObject({ folderId: mine.id, kind: "image", pageCount: 1 });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses an empty title without touching the upload",
    async () => {
      const { objectKey } = await upload(USER_A, "foto.png", makeImage("png"));
      expect(
        await finalizeUpload(db(), store, {
          ownerId: USER_A,
          objectKey,
          title: "   ",
          now: NOW,
        }),
      ).toEqual({ ok: false, error: "title" });
      expect(await ticketCount()).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );

  const rejected: [string, string, () => Uint8Array | Promise<Uint8Array>][] = [
    ["type", "buku.pdf", makeZip],
    ["type", "papan.png", html],
    ["doc", "modul.docx", makeDoc],
    ["encrypted", "rahasia.pdf", () => makePdf(1, { encrypt: true })],
    ["pages", "tebal.pdf", () => makePdf(301)],
    ["zipBomb", "bom.docx", () => makeZipBombDocx(5_000_000)],
  ];

  it.each(rejected)(
    "refuses %s (%s), deletes the object and frees the reservation",
    async (reason, name, make) => {
      const { objectKey } = await upload(USER_A, name, await make());
      expect(
        await finalizeUpload(db(), store, {
          ownerId: USER_A,
          objectKey,
          title: "Materi",
          now: NOW,
        }),
      ).toEqual({ ok: false, error: reason });
      expect(await store.get(objectKey)).toBeNull();
      expect(await store.get(objectKey.replace(/^uploads\//, "materials/"))).toBeNull();
      expect(await ticketCount()).toBe(0);
      expect(await materialCount()).toBe(0);
      expect(await jobCount()).toBe(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses a stored object larger than the signed size (26 MB for 25 MB) and deletes it",
    async () => {
      const started = await start(USER_A, "besar.pdf", MAX_MATERIAL_BYTES);
      if (!started.ok) throw new Error(started.error);
      await store.put(started.data.objectKey, new Uint8Array(26 * MB), "application/pdf");
      expect(
        await finalizeUpload(db(), store, {
          ownerId: USER_A,
          objectKey: started.data.objectKey,
          title: "Besar",
          now: NOW,
        }),
      ).toEqual({ ok: false, error: "size" });
      expect(await store.get(started.data.objectKey)).toBeNull();
      expect(await ticketCount()).toBe(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "fails cleanly a finalise whose reservation was made under the old 50 MB limit",
    async () => {
      // Reserved and signed by the previous release: 40 MB is over today's limit.
      const id = crypto.randomUUID();
      const objectKey = `uploads/${USER_A}/${id}/source.pdf`;
      await database.db.insert(materialUploads).values({
        id,
        ownerId: USER_A,
        objectKey,
        kind: "pdf",
        mime: "application/pdf",
        sizeBytes: 40 * MB,
        expiresAt: later(30),
        createdAt: NOW,
      });
      // The object really has the reserved size, so only the limit check can refuse it as "size"
      // (a size mismatch cannot).
      await store.put(objectKey, new Uint8Array(40 * MB), "application/pdf");
      expect(
        await finalizeUpload(db(), store, {
          ownerId: USER_A,
          objectKey,
          title: "Lama",
          now: later(1),
        }),
      ).toEqual({ ok: false, error: "size" });
      // Nothing is kept: no reservation, no object, no material, no job.
      expect(await ticketCount()).toBe(0);
      expect(await store.get(objectKey)).toBeNull();
      expect(await materialCount()).toBe(0);
      expect(await jobCount()).toBe(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never lets another teacher finalise (or delete) my upload",
    async () => {
      const { objectKey } = await upload(USER_A, "buku.pdf", makePdf(1));
      expect(
        await finalizeUpload(db(), store, {
          ownerId: USER_B,
          objectKey,
          title: "Curian",
          now: NOW,
        }),
      ).toEqual({ ok: false, error: "notFound" });
      expect(await store.get(objectKey)).not.toBeNull();
      expect(await ticketCount()).toBe(1);
      expect(await materialCount()).toBe(0);
      const mine = await finalizeUpload(db(), store, {
        ownerId: USER_A,
        objectKey,
        title: "Buku",
        now: NOW,
      });
      expect(mine.ok).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "accepts only keys that startUpload issued (a forged key under my own prefix is refused)",
    async () => {
      const forged = `uploads/${USER_A}/${crypto.randomUUID()}/source.pdf`;
      await store.put(forged, makePdf(1), "application/pdf");
      const issued = await upload(USER_A, "asli.pdf", makePdf(1));
      const asFinal = issued.objectKey.replace(/^uploads\//, "materials/");
      for (const objectKey of [
        forged,
        asFinal,
        "uploads/../x",
        "",
        "templates/x/y/logo.png",
      ]) {
        expect(
          await finalizeUpload(db(), store, {
            ownerId: USER_A,
            objectKey,
            title: "Palsu",
            now: NOW,
          }),
          objectKey,
        ).toEqual({ ok: false, error: "notFound" });
      }
      expect(await materialCount()).toBe(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "consumes the reservation once: a second finalise is notFound and keeps the material",
    async () => {
      const { objectKey } = await upload(USER_A, "modul.docx", await makeDocx());
      const input = { ownerId: USER_A, objectKey, title: "Modul", now: NOW };
      const first = await finalizeUpload(db(), store, input);
      if (!first.ok) throw new Error(first.error);
      expect(await finalizeUpload(db(), store, input)).toEqual({
        ok: false,
        error: "notFound",
      });
      expect(
        await store.get(`materials/${USER_A}/${first.data.materialId}/source.docx`),
      ).not.toBeNull();
      expect(await materialCount()).toBe(1);
      expect(await jobCount()).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "answers missing while the bytes have not arrived, keeping the reservation",
    async () => {
      const started = await start(USER_A, "buku.pdf", 100);
      if (!started.ok) throw new Error(started.error);
      expect(
        await finalizeUpload(db(), store, {
          ownerId: USER_A,
          objectKey: started.data.objectKey,
          title: "Buku",
          now: NOW,
        }),
      ).toEqual({ ok: false, error: "missing" });
      expect(await ticketCount()).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses an expired reservation and deletes its object",
    async () => {
      const { objectKey } = await upload(USER_A, "buku.pdf", makePdf(1));
      expect(
        await finalizeUpload(db(), store, {
          ownerId: USER_A,
          objectKey,
          title: "Buku",
          now: later(61),
        }),
      ).toEqual({ ok: false, error: "expired" });
      expect(await store.get(objectKey)).toBeNull();
      expect(await ticketCount()).toBe(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "keeps the validated file when the still-valid signed URL is used again after finalise",
    async () => {
      const bytes = makePdf(2);
      const started = await start(USER_A, "buku.pdf", bytes.length);
      if (!started.ok) throw new Error(started.error);
      const { uploadUrl, objectKey, contentType } = started.data;
      const params = new URL(uploadUrl, "http://localhost").searchParams;
      expect(store.acceptSignedPut(params, contentType, bytes)).toBe(true);
      const result = await finalizeUpload(db(), store, {
        ownerId: USER_A,
        objectKey,
        title: "Buku",
        now: NOW,
      });
      if (!result.ok) throw new Error(result.error);

      // Same length, other bytes (HTML), through the URL that is still within its 300 s.
      const evil = new TextEncoder().encode("<html>".padEnd(bytes.length, " "));
      expect(store.acceptSignedPut(params, contentType, evil)).toBe(true);
      const [row] = await database.db.select().from(materials);
      expect(row.objectKey).not.toBe(objectKey);
      expect(await store.get(row.objectKey)).toEqual(bytes);
      // The overwritten staging object can never become a material.
      expect(
        await finalizeUpload(db(), store, {
          ownerId: USER_A,
          objectKey,
          title: "Buku",
          now: NOW,
        }),
      ).toEqual({ ok: false, error: "notFound" });
      expect(await materialCount()).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "removes the final copy, the staging object and the reservation when the material cannot be recorded",
    async () => {
      const { objectKey } = await upload(USER_A, "buku.pdf", makePdf(1));
      const finalKey = objectKey.replace(/^uploads\//, "materials/");
      // A material row already holding the final key makes the insert fail.
      await database.db.insert(materials).values({
        ownerId: USER_A,
        title: "Bentrok",
        kind: "pdf",
        mime: "application/pdf",
        sizeBytes: 1,
        sha256: "0".repeat(64),
        objectKey: finalKey,
      });
      await expect(
        finalizeUpload(db(), store, {
          ownerId: USER_A,
          objectKey,
          title: "Buku",
          now: NOW,
        }),
      ).rejects.toThrow();
      expect(await store.get(finalKey)).toBeNull();
      // A thrown error also drops the reservation and the staging object (upload again).
      expect(await ticketCount()).toBe(0);
      expect(await store.get(objectKey)).toBeNull();
    },
    DB_TEST_TIMEOUT,
  );
});

describe("finalizeUpload: claim, then check outside any transaction", () => {
  it(
    "downloads and validates while no transaction holds the connection",
    async () => {
      const { objectKey } = await upload(USER_A, "buku.pdf", makePdf(1));
      let freeDuringDownload: boolean | undefined;
      const watched: ObjectStore = {
        ...store,
        get: async (key) => {
          // PGlite has one connection: an open finalise transaction would hold this query.
          freeDuringDownload = await Promise.race([
            database.db.execute(sql`select 1`).then(() => true),
            new Promise<boolean>((resolve) =>
              setTimeout(() => {
                resolve(false);
              }, 2_000),
            ),
          ]);
          return store.get(key);
        },
      };
      const result = await finalizeUpload(db(), watched, {
        ownerId: USER_A,
        objectKey,
        title: "Buku",
        now: NOW,
      });
      expect(result.ok).toBe(true);
      expect(freeDuringDownload).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "lets exactly one of two concurrent finalise calls create the material",
    async () => {
      const { objectKey } = await upload(USER_A, "buku.pdf", makePdf(2));
      const input = { ownerId: USER_A, objectKey, title: "Buku", now: NOW };
      const results = await Promise.all([
        finalizeUpload(db(), store, input),
        finalizeUpload(db(), store, input),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        { ok: false, error: "notFound" },
      ]);
      expect(await materialCount()).toBe(1);
      expect(await jobCount()).toBe(1);
      const [row] = await database.db.select().from(materials);
      expect(await store.get(row.objectKey)).not.toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "deletes the staging object and the reservation when the store throws, then rethrows",
    async () => {
      const { objectKey } = await upload(USER_A, "buku.pdf", makePdf(1));
      const failing: ObjectStore = {
        ...store,
        get: () => Promise.reject(new Error("R2 unavailable")),
      };
      await expect(
        finalizeUpload(db(), failing, {
          ownerId: USER_A,
          objectKey,
          title: "Buku",
          now: NOW,
        }),
      ).rejects.toThrow("R2 unavailable");
      expect(await store.get(objectKey)).toBeNull();
      expect(await ticketCount()).toBe(0);
      expect(await materialCount()).toBe(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "releases the claim when the bytes are missing, so a later finalise succeeds",
    async () => {
      const bytes = makePdf(1);
      const started = await start(USER_A, "buku.pdf", bytes.length);
      if (!started.ok) throw new Error(started.error);
      const input = {
        ownerId: USER_A,
        objectKey: started.data.objectKey,
        title: "Buku",
        now: NOW,
      };
      expect(await finalizeUpload(db(), store, input)).toEqual({
        ok: false,
        error: "missing",
      });
      await store.put(started.data.objectKey, bytes, "application/pdf");
      expect((await finalizeUpload(db(), store, input)).ok).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("cancelUpload", () => {
  it(
    "deletes the staging object but keeps the reservation counting until it expires",
    async () => {
      const { objectKey } = await upload(USER_A, "buku.pdf", makePdf(1));
      expect(
        await cancelUpload(db(), store, { ownerId: USER_A, objectKey, now: NOW }),
      ).toEqual({ ok: true, data: undefined });
      expect(await store.get(objectKey)).toBeNull();
      const [row] = await database.db.select().from(materialUploads);
      expect(row.cancelledAt?.getTime()).toBe(NOW.getTime());
      // A second cancel finds nothing left to cancel.
      expect(
        await cancelUpload(db(), store, { ownerId: USER_A, objectKey, now: NOW }),
      ).toEqual({ ok: false, error: "notFound" });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "cannot be used to bypass the storage cap (start, cancel, start again)",
    async () => {
      await seedStored(USER_A, STORAGE_CAP_BYTES - 10 * MB);
      const first = await start(USER_A, "a.pdf", 10 * MB);
      if (!first.ok) throw new Error(first.error);
      await cancelUpload(db(), store, {
        ownerId: USER_A,
        objectKey: first.data.objectKey,
        now: NOW,
      });
      // The cancelled URL is still valid for minutes, so its bytes still count.
      expect(await start(USER_A, "b.pdf", 10 * MB, "", later(1))).toEqual({
        ok: false,
        error: "quota",
      });
      // Once the reservation expired, the sweep frees it.
      expect((await start(USER_A, "b.pdf", 10 * MB, "", later(61))).ok).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "cannot be used to bypass the pending-upload limit",
    async () => {
      const keys: string[] = [];
      for (let i = 0; i < MAX_PENDING_UPLOADS; i += 1) {
        const started = await start(USER_A, `${String(i)}.pdf`, 10);
        if (!started.ok) throw new Error(started.error);
        keys.push(started.data.objectKey);
      }
      await cancelUpload(db(), store, { ownerId: USER_A, objectKey: keys[0], now: NOW });
      expect(await start(USER_A, "lagi.pdf", 10, "", later(1))).toEqual({
        ok: false,
        error: "pending",
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never finalises a cancelled upload, even after a PUT through its still-valid URL",
    async () => {
      const bytes = makePdf(1);
      const started = await start(USER_A, "buku.pdf", bytes.length);
      if (!started.ok) throw new Error(started.error);
      const { uploadUrl, objectKey, contentType } = started.data;
      await cancelUpload(db(), store, { ownerId: USER_A, objectKey, now: NOW });
      const params = new URL(uploadUrl, "http://localhost").searchParams;
      expect(store.acceptSignedPut(params, contentType, bytes)).toBe(true);
      expect(
        await finalizeUpload(db(), store, {
          ownerId: USER_A,
          objectKey,
          title: "Buku",
          now: later(1),
        }),
      ).toEqual({ ok: false, error: "notFound" });
      expect(await materialCount()).toBe(0);
      // The late object goes with the reservation once it expires.
      expect((await start(USER_A, "lain.pdf", 10, "", later(61))).ok).toBe(true);
      expect(await store.get(objectKey)).toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "never cancels another teacher's upload, nor a finalised one",
    async () => {
      const { objectKey } = await upload(USER_A, "buku.pdf", makePdf(1));
      expect(
        await cancelUpload(db(), store, { ownerId: USER_B, objectKey, now: NOW }),
      ).toEqual({
        ok: false,
        error: "notFound",
      });
      expect(await store.get(objectKey)).not.toBeNull();
      expect(await ticketCount()).toBe(1);
      const finalised = await finalizeUpload(db(), store, {
        ownerId: USER_A,
        objectKey,
        title: "Buku",
        now: NOW,
      });
      if (!finalised.ok) throw new Error(finalised.error);
      expect(
        await cancelUpload(db(), store, { ownerId: USER_A, objectKey, now: NOW }),
      ).toEqual({
        ok: false,
        error: "notFound",
      });
      expect(await materialCount()).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );
});
