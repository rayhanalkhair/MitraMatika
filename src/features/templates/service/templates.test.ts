import { createHash } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { sql } from "drizzle-orm";
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
import { runAsUser } from "@/lib/db/client";
import { schoolTemplates } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { logger } from "@/lib/logger";
import { createMemoryStore } from "@/lib/storage/memory";
import type { ObjectStore } from "@/lib/storage";
import type { TemplateInput } from "../schema/template";
import { readLogo, uploadLogo } from "./logo";
import {
  getTemplate,
  listTemplates,
  saveTemplate,
  setDefaultTemplate,
  type TemplateDb,
} from "./templates";

let database: TestDatabase;
let store: ObjectStore;
const db = () => database.db as unknown as TemplateDb;

const INPUT: TemplateInput = {
  name: "Kop utama",
  schoolName: "SMP Negeri 1 Surabaya",
  headerLines: ["Pemerintah Kota Surabaya", "Dinas Pendidikan"],
  subject: "Matematika",
  studentFields: ["name", "class", "number", "date"],
  defaultInstructions: "Kerjakan dengan teliti.",
  paperSize: "A4",
  font: "times",
  isDefault: false,
};

const asUser = <T>(userId: string, fn: (tx: TemplateDb) => Promise<T>) =>
  runAsUser(db(), userId, (tx) => fn(tx as unknown as TemplateDb));

async function create(ownerId: string, input: Partial<TemplateInput> = {}) {
  const saved = await asUser(ownerId, (tx) =>
    saveTemplate(tx, { ownerId, input: { ...INPUT, ...input } }),
  );
  if (!saved.ok) throw new Error(saved.error);
  return saved.data;
}

async function defaults(ownerId: string) {
  const rows = await database.db.execute<{ id: string }>(
    sql`select id from school_templates where owner_id = ${ownerId} and is_default and deleted_at is null`,
  );
  return rows.rows.map((row) => row.id);
}

function png(): Uint8Array {
  const canvas = createCanvas(4, 4);
  canvas.getContext("2d").fillRect(0, 0, 4, 4);
  return new Uint8Array(canvas.encodeSync("png"));
}
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="1"/></svg>',
);

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await database.db.delete(schoolTemplates);
  store = createMemoryStore();
});

describe("saveTemplate", () => {
  it("creates the first template as the default, with every field stored", async () => {
    const { id, rowVersion } = await create(USER_A);
    expect(rowVersion).toBe(1);
    const read = await asUser(USER_A, (tx) =>
      getTemplate(tx, { ownerId: USER_A, templateId: id }),
    );
    expect(read).toEqual({
      ok: true,
      data: {
        id,
        ...INPUT,
        isDefault: true,
        rowVersion: 1,
        hasLogo: false,
      },
    });
  });

  it("updates with the row version it was given and bumps it; a stale one is a conflict", async () => {
    const { id } = await create(USER_A);
    const updated = await asUser(USER_A, (tx) =>
      saveTemplate(tx, {
        ownerId: USER_A,
        templateId: id,
        input: { ...INPUT, schoolName: "SMP 2", paperSize: "F4", font: "arial" },
        expectedRowVersion: 1,
      }),
    );
    expect(updated).toEqual({ ok: true, data: { id, rowVersion: 2 } });
    const stale = await asUser(USER_A, (tx) =>
      saveTemplate(tx, {
        ownerId: USER_A,
        templateId: id,
        input: { ...INPUT, schoolName: "SMP 3" },
        expectedRowVersion: 1,
      }),
    );
    expect(stale).toEqual({ ok: false, error: "conflict" });
    const read = await asUser(USER_A, (tx) =>
      getTemplate(tx, { ownerId: USER_A, templateId: id }),
    );
    expect(read.ok && read.data).toMatchObject({
      schoolName: "SMP 2",
      paperSize: "F4",
      font: "arial",
      rowVersion: 2,
    });
  });

  it("keeps exactly one default per owner, whatever is saved", async () => {
    const first = await create(USER_A);
    const second = await create(USER_A, { name: "Kop kedua" });
    expect(await defaults(USER_A)).toEqual([first.id]);
    // Saving another template as default moves the default.
    const third = await create(USER_A, { name: "Kop ketiga", isDefault: true });
    expect(await defaults(USER_A)).toEqual([third.id]);
    // Unticking default on the default template does not leave the owner without one.
    await asUser(USER_A, (tx) =>
      saveTemplate(tx, {
        ownerId: USER_A,
        templateId: third.id,
        input: { ...INPUT, name: "Kop ketiga", isDefault: false },
        expectedRowVersion: 1,
      }),
    );
    expect(await defaults(USER_A)).toEqual([third.id]);
    expect(second.id).not.toBe(third.id);
  });
});

describe("setDefaultTemplate", () => {
  it("moves the default to the chosen template only", async () => {
    const first = await create(USER_A);
    const second = await create(USER_A, { name: "Kop kedua" });
    const result = await asUser(USER_A, (tx) =>
      setDefaultTemplate(tx, { ownerId: USER_A, templateId: second.id }),
    );
    expect(result).toEqual({ ok: true, data: undefined });
    expect(await defaults(USER_A)).toEqual([second.id]);
    // Choosing the current default again changes nothing.
    await asUser(USER_A, (tx) =>
      setDefaultTemplate(tx, { ownerId: USER_A, templateId: second.id }),
    );
    expect(await defaults(USER_A)).toEqual([second.id]);
    expect(first.id).not.toBe(second.id);
  });

  it("does not choose a trashed template", async () => {
    await create(USER_A);
    const trashed = await create(USER_A, { name: "Lama" });
    await database.db.execute(
      sql`update school_templates set deleted_at = now() where id = ${trashed.id}`,
    );
    expect(
      await asUser(USER_A, (tx) =>
        setDefaultTemplate(tx, { ownerId: USER_A, templateId: trashed.id }),
      ),
    ).toEqual({ ok: false, error: "notFound" });
  });
});

// Races are staged with a trigger that fires when the old default is cleared, standing in for
// another tab that bumps or trashes the target row at that moment. The write must then roll back
// as a whole: the teacher never ends up without a default.
describe("switching the default is all or nothing", () => {
  afterEach(async () => {
    await database.db.execute(sql`drop function if exists test_race() cascade`);
  });

  async function onDefaultCleared(body: string) {
    await database.db.execute(
      sql.raw(`create function test_race() returns trigger language plpgsql security definer as $$
        begin ${body}; return null; end $$`),
    );
    await database.db.execute(
      sql.raw(`create trigger test_race after update on school_templates for each row
        when (old.is_default and not new.is_default) execute function test_race()`),
    );
  }

  it("a stale save that asked to become the default leaves the previous default in place", async () => {
    const first = await create(USER_A);
    const target = await create(USER_A, { name: "Target" });
    expect(
      await asUser(USER_A, (tx) =>
        saveTemplate(tx, {
          ownerId: USER_A,
          templateId: target.id,
          input: { ...INPUT, name: "Target", isDefault: true },
          expectedRowVersion: 7,
        }),
      ),
    ).toEqual({ ok: false, error: "conflict" });
    expect(await defaults(USER_A)).toEqual([first.id]);
  });

  it("rolls back a save whose row changed after the old default was cleared", async () => {
    const first = await create(USER_A);
    const target = await create(USER_A, { name: "Target" });
    await onDefaultCleared(
      "update school_templates set row_version = row_version + 1 where name = 'Target'",
    );
    const result = await asUser(USER_A, (tx) =>
      saveTemplate(tx, {
        ownerId: USER_A,
        templateId: target.id,
        input: { ...INPUT, name: "Target", schoolName: "Baru", isDefault: true },
        expectedRowVersion: 1,
      }),
    );
    expect(result).toEqual({ ok: false, error: "conflict" });
    expect(await defaults(USER_A)).toEqual([first.id]);
    const read = await asUser(USER_A, (tx) =>
      getTemplate(tx, { ownerId: USER_A, templateId: first.id }),
    );
    expect(read.ok && read.data.rowVersion).toBe(1);
  });

  it("rolls back setDefaultTemplate when the target is trashed meanwhile, and changes nothing", async () => {
    const first = await create(USER_A);
    const target = await create(USER_A, { name: "Target" });
    await onDefaultCleared(
      "update school_templates set deleted_at = now() where name = 'Target'",
    );
    expect(
      await asUser(USER_A, (tx) =>
        setDefaultTemplate(tx, { ownerId: USER_A, templateId: target.id }),
      ),
    ).toEqual({ ok: false, error: "notFound" });
    expect(await defaults(USER_A)).toEqual([first.id]);
    const trashed = await database.db.execute<{ deleted_at: string | null }>(
      sql`select deleted_at from school_templates where id = ${target.id}`,
    );
    expect(trashed.rows[0]?.deleted_at).toBeNull();
  });

  it("answers a retryable conflict when another tab created the first default meanwhile", async () => {
    await database.db.execute(
      sql.raw(`create function test_race() returns trigger language plpgsql security definer as $$
        begin
          insert into school_templates (owner_id, name, school_name, is_default)
          values (new.owner_id, 'Other tab', 'SMP', true);
          return new;
        end $$`),
    );
    await database.db.execute(
      sql.raw(`create trigger test_race before insert on school_templates for each row
        when (new.name = 'Race') execute function test_race()`),
    );
    const result = await asUser(USER_A, async (tx) => {
      const saved = await saveTemplate(tx, {
        ownerId: USER_A,
        input: { ...INPUT, name: "Race" },
      });
      // The transaction is still usable after the refused insert.
      const list = await listTemplates(tx, USER_A);
      return { saved, count: list.length };
    });
    expect(result).toEqual({ saved: { ok: false, error: "conflict" }, count: 0 });
  });
});

describe("listTemplates and getTemplate", () => {
  it("list the owner's templates, default first, and hide trashed ones", async () => {
    const first = await create(USER_A, { name: "B kop" });
    const second = await create(USER_A, { name: "A kop" });
    const trashed = await create(USER_A, { name: "Sampah" });
    await database.db.execute(
      sql`update school_templates set deleted_at = now() where id = ${trashed.id}`,
    );
    await create(USER_B, { name: "Milik B" });
    const list = await asUser(USER_A, (tx) => listTemplates(tx, USER_A));
    expect(list.map((t) => t.id)).toEqual([first.id, second.id]);
    expect(
      await asUser(USER_A, (tx) =>
        getTemplate(tx, { ownerId: USER_A, templateId: trashed.id }),
      ),
    ).toEqual({ ok: false, error: "notFound" });
  });

  it("answers not found for an id that is not a uuid", async () => {
    expect(
      await asUser(USER_A, (tx) =>
        getTemplate(tx, { ownerId: USER_A, templateId: "../x" }),
      ),
    ).toEqual({ ok: false, error: "notFound" });
  });
});

describe("another teacher's template", () => {
  it("cannot be read, changed, made default or given a logo", async () => {
    const mine = await create(USER_A);
    await create(USER_B, { name: "Milik B" });

    expect(
      await asUser(USER_B, (tx) =>
        getTemplate(tx, { ownerId: USER_B, templateId: mine.id }),
      ),
    ).toEqual({ ok: false, error: "notFound" });
    expect(await asUser(USER_B, (tx) => listTemplates(tx, USER_B))).toHaveLength(1);

    expect(
      await asUser(USER_B, (tx) =>
        saveTemplate(tx, {
          ownerId: USER_B,
          templateId: mine.id,
          input: { ...INPUT, schoolName: "Diubah B" },
          expectedRowVersion: 1,
        }),
      ),
    ).toEqual({ ok: false, error: "notFound" });

    expect(
      await asUser(USER_B, (tx) =>
        setDefaultTemplate(tx, { ownerId: USER_B, templateId: mine.id }),
      ),
    ).toEqual({ ok: false, error: "notFound" });

    expect(
      await uploadLogo(store, db(), {
        ownerId: USER_B,
        templateId: mine.id,
        bytes: png(),
        declaredType: "image/png",
      }),
    ).toEqual({ ok: false, error: "notFound" });
    expect(await store.get(`templates/${USER_B}/${mine.id}/logo.png`)).toBeNull();
    expect(await store.get(`templates/${USER_A}/${mine.id}/logo.png`)).toBeNull();

    // A's template is untouched and still A's default.
    const read = await asUser(USER_A, (tx) =>
      getTemplate(tx, { ownerId: USER_A, templateId: mine.id }),
    );
    expect(read.ok && read.data).toMatchObject({
      schoolName: INPUT.schoolName,
      rowVersion: 1,
      isDefault: true,
      hasLogo: false,
    });
  });

  it("records the sha-256 of the stored bytes with the key, also for a same-format replacement (R26)", async () => {
    const mine = await create(USER_A);
    const shaOfRow = async () =>
      (
        await database.db.execute<{ logo_sha256: string | null }>(
          sql`select logo_sha256 from school_templates where id = ${mine.id}`,
        )
      ).rows[0]?.logo_sha256;
    const key = `templates/${USER_A}/${mine.id}/logo.png`;
    const first = png();
    await uploadLogo(store, db(), {
      ownerId: USER_A,
      templateId: mine.id,
      bytes: first,
      declaredType: "image/png",
    });
    const stored = await store.get(key);
    expect(stored).not.toBeNull();
    const firstSha = createHash("sha256")
      .update(stored ?? new Uint8Array())
      .digest("hex");
    expect(await shaOfRow()).toBe(firstSha);
    // Another PNG under the same key.
    const second = new Uint8Array(first);
    second[second.length - 1] ^= 0xff;
    await uploadLogo(store, db(), {
      ownerId: USER_A,
      templateId: mine.id,
      bytes: second,
      declaredType: "image/png",
    });
    const replaced = await shaOfRow();
    expect(replaced).toMatch(/^[0-9a-f]{64}$/);
    expect(replaced).not.toBe(firstSha);
  });

  it("serves and deletes nothing when a logo_key points at another teacher's object", async () => {
    const theirs = await create(USER_B, { name: "Milik B" });
    await uploadLogo(store, db(), {
      ownerId: USER_B,
      templateId: theirs.id,
      bytes: png(),
      declaredType: "image/png",
    });
    const theirKey = `templates/${USER_B}/${theirs.id}/logo.png`;
    const mine = await create(USER_A);
    // A rewritten column (the grant no longer allows it; defence in depth for any other path).
    await database.db.execute(
      sql`update school_templates set logo_key = ${theirKey} where id = ${mine.id}`,
    );
    const warned = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    expect(await readLogo(store, db(), { ownerId: USER_A, templateId: mine.id })).toEqual(
      {
        ok: false,
        error: "notFound",
      },
    );
    // Replacing it with another format must not delete what the column pointed at.
    expect(
      await uploadLogo(store, db(), {
        ownerId: USER_A,
        templateId: mine.id,
        bytes: SVG,
        declaredType: "image/svg+xml",
      }),
    ).toEqual({ ok: true, data: { logoKey: `templates/${USER_A}/${mine.id}/logo.svg` } });
    expect(await store.get(theirKey)).not.toBeNull();
    // Logged without the key itself.
    expect(warned).toHaveBeenCalledWith(
      { module: "templates", templateId: mine.id },
      "templates: logo_key outside the template's own prefix; ignored",
    );
    expect(JSON.stringify(warned.mock.calls)).not.toContain(USER_B);
    warned.mockRestore();
  });

  it("does not serve its logo", async () => {
    const mine = await create(USER_A);
    await uploadLogo(store, db(), {
      ownerId: USER_A,
      templateId: mine.id,
      bytes: png(),
      declaredType: "image/png",
    });
    expect(await readLogo(store, db(), { ownerId: USER_B, templateId: mine.id })).toEqual(
      {
        ok: false,
        error: "notFound",
      },
    );
    expect(
      await readLogo(store, db(), { ownerId: USER_A, templateId: mine.id }),
    ).toMatchObject({
      ok: true,
      data: { contentType: "image/png" },
    });
  });
});

describe("uploadLogo", () => {
  it("stores the logo under ids only, records the key and bumps the row version", async () => {
    const logged = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const { id } = await create(USER_A);
    const result = await uploadLogo(store, db(), {
      ownerId: USER_A,
      templateId: id,
      bytes: png(),
      declaredType: "image/jpeg",
    });
    const key = `templates/${USER_A}/${id}/logo.png`;
    expect(result).toEqual({ ok: true, data: { logoKey: key } });
    expect(await store.get(key)).not.toBeNull();
    const row = await database.db.execute<{ logo_key: string; row_version: number }>(
      sql`select logo_key, row_version from school_templates where id = ${id}`,
    );
    expect(row.rows[0]).toEqual({ logo_key: key, row_version: 2 });
    // Declared as a JPEG, stored as the PNG it is; the mismatch is noted without any name.
    expect(logged).toHaveBeenCalledWith(
      { module: "templates", ext: "png" },
      "templates: logo type differs from the declared type; stored by its bytes",
    );
    logged.mockRestore();
  });

  it("replacing the logo with another format deletes the old object", async () => {
    const { id } = await create(USER_A);
    await uploadLogo(store, db(), {
      ownerId: USER_A,
      templateId: id,
      bytes: png(),
      declaredType: "image/png",
    });
    const result = await uploadLogo(store, db(), {
      ownerId: USER_A,
      templateId: id,
      bytes: SVG,
      declaredType: "image/svg+xml",
    });
    expect(result).toEqual({
      ok: true,
      data: { logoKey: `templates/${USER_A}/${id}/logo.svg` },
    });
    expect(await store.get(`templates/${USER_A}/${id}/logo.png`)).toBeNull();
    const served = await readLogo(store, db(), { ownerId: USER_A, templateId: id });
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    expect(served.data.contentType).toBe("image/svg+xml");
    const text = new TextDecoder().decode(served.data.bytes);
    expect(text).not.toContain("onload");
  });

  it("stores nothing for an invalid file or a trashed template", async () => {
    const { id } = await create(USER_A);
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
    expect(
      await uploadLogo(store, db(), {
        ownerId: USER_A,
        templateId: id,
        bytes: exe,
        declaredType: "image/png",
      }),
    ).toEqual({ ok: false, error: "unsupportedType" });
    expect(await store.get(`templates/${USER_A}/${id}/logo.png`)).toBeNull();

    await database.db.execute(
      sql`update school_templates set deleted_at = now() where id = ${id}`,
    );
    expect(
      await uploadLogo(store, db(), {
        ownerId: USER_A,
        templateId: id,
        bytes: png(),
        declaredType: "image/png",
      }),
    ).toEqual({ ok: false, error: "notFound" });
    expect(await store.get(`templates/${USER_A}/${id}/logo.png`)).toBeNull();
  });
});
