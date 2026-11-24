import { createCanvas } from "@napi-rs/canvas";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { materials, schoolTemplates } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { logger } from "@/lib/logger";
import { APP_STORAGE_CAP_BYTES, appStorageUsage } from "@/lib/storage/app-total";
import {
  APP_LOCK_EVENT,
  lockTimeoutError,
  recordLocks,
} from "@/lib/storage/lock-recorder";
import { createMemoryStore } from "@/lib/storage/memory";
import type { ObjectStore } from "@/lib/storage";
import { uploadLogo } from "./logo";
import type { TemplateDb } from "./templates";

// ADR-0022: the app-wide 6 GiB cap on the logo upload.
let database: TestDatabase;
let store: ObjectStore;
const db = () => database.db as unknown as TemplateDb;
const TEMPLATE = "11111111-1111-4111-8111-111111111111";

function png(width = 4): Uint8Array {
  const canvas = createCanvas(width, 4);
  canvas.getContext("2d").fillRect(0, 0, width, 4);
  return new Uint8Array(canvas.encodeSync("png"));
}

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await database.db.execute(sql`truncate materials, school_templates cascade`);
  await database.db.insert(schoolTemplates).values({
    id: TEMPLATE,
    ownerId: USER_A,
    name: "Kop",
    schoolName: "SMP 1",
  });
  store = createMemoryStore();
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

/** Fills the app (as another teacher's stored file) until `room` bytes are left. */
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
const upload = (bytes: Uint8Array) =>
  uploadLogo(store, db(), {
    ownerId: USER_A,
    templateId: TEMPLATE,
    bytes,
    declaredType: "image/png",
  });
const row = async () =>
  (
    await database.db.execute<{ logo_key: string | null; logo_bytes: number | null }>(
      sql`select logo_key, logo_bytes from school_templates where id = ${TEMPLATE}`,
    )
  ).rows[0];

describe("uploadLogo and the app-wide cap", () => {
  it(
    "records the stored byte length in logo_bytes",
    async () => {
      const bytes = png();
      expect((await upload(bytes)).ok).toBe(true);
      expect((await row()).logo_bytes).toBe(bytes.length);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "passes at exactly the cap and refuses one byte more, storing nothing",
    async () => {
      const bytes = png();
      await leaveRoom(bytes.length - 1);
      expect(await upload(bytes)).toEqual({ ok: false, error: "appFull" });
      expect(await row()).toEqual({ logo_key: null, logo_bytes: null });
      expect(await store.get(`templates/${USER_A}/${TEMPLATE}/logo.png`)).toBeNull();
      await database.db.execute(sql`truncate materials cascade`);
      await leaveRoom(bytes.length);
      expect((await upload(bytes)).ok).toBe(true);
      expect((await appStorageUsage(db())).usedBytes).toBe(APP_STORAGE_CAP_BYTES);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "counts only the growth when a logo replaces another",
    async () => {
      const first = png();
      await upload(first);
      await leaveRoom(0);
      // The same size replaces it in a full app; a larger one does not fit.
      expect((await upload(png())).ok).toBe(true);
      expect(await upload(png(64))).toEqual({ ok: false, error: "appFull" });
      expect((await row()).logo_bytes).toBe(first.length);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "puts the object first and takes the app lock once, only afterwards, under a short lock_timeout",
    async () => {
      const events: string[] = [];
      const spied = new Proxy(store, {
        get(target, prop, receiver) {
          if (prop !== "put") return Reflect.get(target, prop, receiver) as unknown;
          return async (...args: Parameters<ObjectStore["put"]>) => {
            events.push("put");
            await target.put(...args);
          };
        },
      });
      const result = await uploadLogo(spied, recordLocks(db(), events), {
        ownerId: USER_A,
        templateId: TEMPLATE,
        bytes: png(),
        declaredType: "image/png",
      });
      expect(result.ok).toBe(true);
      expect(events).toEqual(["put", "timeout:'3000ms'", APP_LOCK_EVENT, "timeout:0"]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "answers storageBusy when the app lock is busy and removes the object it put",
    async () => {
      const busy = recordLocks(db(), [], (statement) => {
        if (statement.includes("app_storage_cap")) throw lockTimeoutError();
        return Promise.resolve();
      });
      const result = await uploadLogo(store, busy, {
        ownerId: USER_A,
        templateId: TEMPLATE,
        bytes: png(),
        declaredType: "image/png",
      });
      expect(result).toEqual({ ok: false, error: "storageBusy" });
      expect(await row()).toEqual({ logo_key: null, logo_bytes: null });
      expect(await store.get(`templates/${USER_A}/${TEMPLATE}/logo.png`)).toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "puts the previous logo back when a same-key replacement loses the race for the last room",
    async () => {
      const first = png();
      await upload(first);
      const key = `templates/${USER_A}/${TEMPLATE}/logo.png`;
      // The room vanishes between the early check and the locked one: another teacher's file
      // is stored (in the same transaction, as a stand-in for a concurrent commit) right before
      // the app lock is taken.
      const bigger = png(64);
      const { usedBytes } = await appStorageUsage(db());
      const filler = crypto.randomUUID();
      const racing = recordLocks(db(), [], async (statement, tx) => {
        if (!statement.includes("app_storage_cap")) return;
        await tx.execute(
          sql`insert into materials (id, owner_id, title, kind, mime, size_bytes, sha256, object_key) values (${filler}, ${USER_B}, 'Buku', 'pdf', 'application/pdf', ${APP_STORAGE_CAP_BYTES - usedBytes}, ${"0".repeat(64)}, ${`materials/${USER_B}/${filler}/source.pdf`})`,
        );
      });
      expect(
        await uploadLogo(store, racing, {
          ownerId: USER_A,
          templateId: TEMPLATE,
          bytes: bigger,
          declaredType: "image/png",
        }),
      ).toEqual({ ok: false, error: "appFull" });
      expect(await store.get(key)).toEqual(first);
      expect((await row()).logo_bytes).toBe(first.length);
    },
    DB_TEST_TIMEOUT,
  );
});
