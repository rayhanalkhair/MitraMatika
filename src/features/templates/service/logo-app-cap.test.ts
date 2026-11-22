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
});
