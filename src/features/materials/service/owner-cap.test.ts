import { sql } from "drizzle-orm";
import { createCanvas } from "@napi-rs/canvas";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startPhotoSession } from "@/features/solver";
import { uploadLogo } from "@/features/templates";
import { FIXTURE, seedFixtures } from "@/lib/db/test-fixtures";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { logger } from "@/lib/logger";
import { createMemoryStore, type MemoryStore } from "@/lib/storage/memory";
import { TEACHER_STORAGE_CAP_BYTES } from "@/lib/storage/limits";
import { STORAGE_CAP_BYTES } from "../schema/upload";
import { startUpload } from "./upload";

// Security review F1: the 300 MB per-teacher cap counts EVERY kind of file (logos, exports and
// solver photos too), so one teacher cannot fill the app with them, and another teacher is not
// affected by it.
let database: TestDatabase;
let store: MemoryStore;
const NOW = new Date("2026-11-22T03:00:00.000Z");
const MB = 1024 * 1024;
const run = (statement: string) => database.db.execute(sql.raw(statement));

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
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
  // The fixtures hold small files: start from nothing but the rows themselves.
  await run(`delete from material_uploads`);
  await run(`delete from materials`);
  await run(`update exports set size_bytes = 0`);
  await run(
    `update school_templates set logo_key = 'x/' || owner_id || '/logo.png', logo_bytes = 0`,
  );
  await run(
    `update solver_sessions set input_key = 'solver/' || owner_id || '/x.png', input_bytes = 0`,
  );
  store = createMemoryStore({ uploadPath: "/api/dev/upload" });
  vi.restoreAllMocks();
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

/** Puts the teacher exactly at the cap with one kind of file (the cap itself still passes). */
const fill = {
  logos: (o: 1 | 2) =>
    run(
      `update school_templates set logo_bytes = ${String(TEACHER_STORAGE_CAP_BYTES)} where id = '${FIXTURE.template(o)}'`,
    ),
  exports: (o: 1 | 2) =>
    run(
      `update exports set size_bytes = ${String(TEACHER_STORAGE_CAP_BYTES)} where id = '${FIXTURE.export(o)}'`,
    ),
  photos: (o: 1 | 2) =>
    run(
      `update solver_sessions set input_bytes = ${String(TEACHER_STORAGE_CAP_BYTES)} where id = '${FIXTURE.solverSession(o)}'`,
    ),
};
const KINDS = ["logos", "exports", "photos"] as const;

const upload = (ownerId: string, size = MB) =>
  startUpload(database.db, store, {
    ownerId,
    fileName: "buku.pdf",
    declaredType: "",
    size,
    now: NOW,
  });
const photo = (ownerId: string, size = 1000) =>
  startPhotoSession(database.db, store, {
    ownerId,
    kind: "photo",
    mime: "image/png",
    size,
    now: NOW,
  });
function png(): Uint8Array {
  const canvas = createCanvas(4, 4);
  canvas.getContext("2d").fillRect(0, 0, 4, 4);
  return new Uint8Array(canvas.encodeSync("png"));
}
const logo = (ownerId: string, o: 1 | 2) =>
  uploadLogo(store, database.db, {
    ownerId,
    templateId: FIXTURE.template(o),
    bytes: png(),
    declaredType: "image/png",
  });

describe("the per-teacher cap counts every kind of file", () => {
  it("is the same 300 MB as the materials meter", () => {
    expect(STORAGE_CAP_BYTES).toBe(TEACHER_STORAGE_CAP_BYTES);
    expect(TEACHER_STORAGE_CAP_BYTES).toBe(300 * MB);
  });

  for (const kind of KINDS) {
    it(
      `a teacher at the cap through ${kind} is refused by every writer, another teacher is not`,
      async () => {
        await fill[kind](1);
        expect(await upload(USER_A)).toEqual({ ok: false, error: "quota" });
        expect(await photo(USER_A)).toEqual({ ok: false, error: "quota" });
        // A logo of another size only replaces what it replaces; the growth is what counts.
        expect(await logo(USER_A, 1)).toEqual(
          kind === "logos"
            ? { ok: true, data: expect.anything() as unknown }
            : { ok: false, error: "quota" },
        );
        // Teacher B has nothing: all three go through.
        expect((await upload(USER_B)).ok).toBe(true);
        expect((await photo(USER_B)).ok).toBe(true);
        expect((await logo(USER_B, 2)).ok).toBe(true);
      },
      DB_TEST_TIMEOUT,
    );
  }

  it(
    "lets a teacher exactly at the cap through logos replace that logo by a smaller one",
    async () => {
      await fill.logos(1);
      // The replacement shrinks the logo: no growth, so it passes even in a full account.
      expect((await logo(USER_A, 1)).ok).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "counts the sum of the kinds together, and one byte over is refused",
    async () => {
      const part = Math.floor(TEACHER_STORAGE_CAP_BYTES / 3) - 1000;
      await run(
        `update school_templates set logo_bytes = ${String(part)} where id = '${FIXTURE.template(1)}'`,
      );
      await run(
        `update exports set size_bytes = ${String(part)} where id = '${FIXTURE.export(1)}'`,
      );
      await run(
        `update solver_sessions set input_bytes = ${String(part)} where id = '${FIXTURE.solverSession(1)}'`,
      );
      const room = TEACHER_STORAGE_CAP_BYTES - 3 * part;
      expect((await photo(USER_A, room + 1)).ok).toBe(false);
      expect((await photo(USER_A, room)).ok).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );
});
