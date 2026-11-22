import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assessments, deletionLog, schoolTemplates } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { logger } from "@/lib/logger";
import type { AnyDb } from "@/features/generation";
import {
  approve,
  createAssessment,
  getApprovalState,
  reopen,
  updateAssessment,
  verifyApproval,
} from "@/features/assessments";
import { requestExport } from "@/features/export";
import { jobs } from "@/lib/db/schema";
import { ASSESSMENT_INPUT } from "@/features/assessments/test-support";
import { listTemplates } from "@/features/templates";
import { asUser, seedApprovedAssessment } from "@/features/export/db-test-support";
import { clearTrashTables, listingStore } from "../db-test-support";
import { trashAssessment } from "./assessment-trash";
import {
  deleteTemplatePermanently,
  listTrashedTemplates,
  purgeExpiredTemplates,
  restoreTemplate,
  trashTemplate,
} from "./template-trash";
import { purgeTrashOncePerDay } from "./purge";

let database: TestDatabase;
const db = () => database.db as unknown as AnyDb;
const NOW = new Date("2026-11-20T03:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await clearTrashTables(database);
});

const rowOf = async (id: string) =>
  (await database.db.select().from(schoolTemplates).where(eq(schoolTemplates.id, id))).at(
    0,
  );

/** A template of the owner, with a stored logo under its own prefix when `logo` is set. */
async function seedTemplate(
  store: ReturnType<typeof listingStore>,
  ownerId: string,
  input: { name?: string; isDefault?: boolean; logo?: boolean } = {},
) {
  const [row] = await database.db
    .insert(schoolTemplates)
    .values({
      ownerId,
      name: input.name ?? "Standar",
      schoolName: "SMP Negeri 1 Contoh",
      isDefault: input.isDefault ?? false,
    })
    .returning({ id: schoolTemplates.id });
  if (input.logo) {
    const key = `templates/${ownerId}/${row.id}/logo.png`;
    await store.put(key, new Uint8Array([1]), "image/png");
    await database.db
      .update(schoolTemplates)
      .set({ logoKey: key })
      .where(eq(schoolTemplates.id, row.id));
  }
  return row.id;
}

const trash = (ownerId: string, templateId: string, now = NOW) =>
  trashTemplate(db(), { ownerId, templateId, now });

describe("trashTemplate", () => {
  it(
    "moves the owner's template to the trash for 30 days and out of the template list",
    async () => {
      const store = listingStore();
      const kept = await seedTemplate(store, USER_A, { name: "Lain", isDefault: true });
      const templateId = await seedTemplate(store, USER_A, { logo: true });
      expect(await trash(USER_A, templateId)).toEqual({ ok: true, data: undefined });
      const row = await rowOf(templateId);
      expect(row?.deletedAt).toEqual(NOW);
      expect(row?.purgeAfter).toEqual(new Date(NOW.getTime() + 30 * DAY_MS));
      expect(
        (await asUser(database, USER_A, (tx) => listTemplates(tx, USER_A))).map(
          (template) => template.id,
        ),
      ).toEqual([kept]);
      // Nothing is deleted yet.
      expect(store.keys()).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "is notFound for another teacher's and an already trashed template",
    async () => {
      const store = listingStore();
      const templateId = await seedTemplate(store, USER_A);
      expect(await trash(USER_B, templateId)).toEqual({ ok: false, error: "notFound" });
      expect((await rowOf(templateId))?.deletedAt).toBeNull();
      await trash(USER_A, templateId);
      expect(await trash(USER_A, templateId, new Date(NOW.getTime() + DAY_MS))).toEqual({
        ok: false,
        error: "notFound",
      });
      expect((await rowOf(templateId))?.deletedAt).toEqual(NOW);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("restoreTemplate", () => {
  it(
    "brings it back exactly as it was, the default still the default",
    async () => {
      const store = listingStore();
      const templateId = await seedTemplate(store, USER_A, {
        isDefault: true,
        logo: true,
      });
      const before = await rowOf(templateId);
      await trash(USER_A, templateId);
      expect(await restoreTemplate(db(), { ownerId: USER_A, templateId })).toEqual({
        ok: true,
        data: { defaultDropped: false },
      });
      const after = await rowOf(templateId);
      expect(after).toEqual({ ...before, updatedAt: after?.updatedAt });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "comes back as a non-default template when another one became the default meanwhile",
    async () => {
      const store = listingStore();
      const templateId = await seedTemplate(store, USER_A, { isDefault: true });
      await trash(USER_A, templateId);
      const other = await seedTemplate(store, USER_A, { name: "Baru", isDefault: true });
      // Reported, so the teacher hears that the version changed (approvals using it go stale).
      expect(await restoreTemplate(db(), { ownerId: USER_A, templateId })).toEqual({
        ok: true,
        data: { defaultDropped: true },
      });
      expect((await rowOf(templateId))?.isDefault).toBe(false);
      expect((await rowOf(templateId))?.deletedAt).toBeNull();
      expect((await rowOf(other))?.isDefault).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "is notInTrash for a live one and notFound for another teacher's",
    async () => {
      const store = listingStore();
      const templateId = await seedTemplate(store, USER_A);
      expect(await restoreTemplate(db(), { ownerId: USER_A, templateId })).toEqual({
        ok: false,
        error: "notInTrash",
      });
      await trash(USER_A, templateId);
      expect(await restoreTemplate(db(), { ownerId: USER_B, templateId })).toEqual({
        ok: false,
        error: "notFound",
      });
      expect((await rowOf(templateId))?.deletedAt).toEqual(NOW);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("a trashed template used by an assessment", () => {
  it(
    "makes the approval stale (panel reason, no export, no job counted) until it is restored",
    async () => {
      const s = await seedApprovedAssessment(database, { ownerId: USER_A });
      const target = { ownerId: USER_A, assessmentId: s.assessmentId };
      await trash(USER_A, s.templateId);

      expect(await verifyApproval(db() as never, target)).toEqual({
        ok: false,
        error: "stale",
      });
      const state = await asUser(database, USER_A, (tx) => getApprovalState(tx, target));
      expect(state).toMatchObject({ approved: true, stale: true });
      expect(state?.problems).toContainEqual({ code: "trashed", template: true });
      expect(await requestExport(db() as never, { ...target, now: NOW })).toEqual({
        ok: false,
        error: { reason: "stale" },
      });
      expect(
        await database.db
          .select({ id: jobs.id })
          .from(jobs)
          .where(eq(jobs.type, "render_export")),
      ).toEqual([]);

      // Restored as it was: nothing printed changed, so the approval is valid again.
      expect(
        await restoreTemplate(db(), { ownerId: USER_A, templateId: s.templateId }),
      ).toMatchObject({ ok: true });
      expect(await verifyApproval(db() as never, target)).toMatchObject({ ok: true });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "keeps the approval valid when it comes back without its default flag (R26)",
    async () => {
      const store = listingStore();
      const s = await seedApprovedAssessment(database, { ownerId: USER_A });
      const target = { ownerId: USER_A, assessmentId: s.assessmentId };
      await database.db
        .update(schoolTemplates)
        .set({ isDefault: true })
        .where(eq(schoolTemplates.id, s.templateId));
      await trash(USER_A, s.templateId);
      await seedTemplate(store, USER_A, { name: "Bawaan baru", isDefault: true });
      expect(
        await restoreTemplate(db(), { ownerId: USER_A, templateId: s.templateId }),
      ).toEqual({ ok: true, data: { defaultDropped: true } });
      expect(await verifyApproval(db() as never, target)).toMatchObject({ ok: true });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "blocks approval until another template is chosen",
    async () => {
      const store = listingStore();
      const s = await seedApprovedAssessment(database, { ownerId: USER_A });
      const replacement = await seedTemplate(store, USER_A, { name: "Pengganti" });
      await asUser(database, USER_A, (tx) =>
        reopen(tx, { ownerId: USER_A, assessmentId: s.assessmentId }),
      );
      await trash(USER_A, s.templateId);

      const approveNow = () =>
        asUser(database, USER_A, (tx) =>
          approve(tx, { ownerId: USER_A, assessmentId: s.assessmentId }),
        );
      expect(await approveNow()).toEqual({
        ok: false,
        error: { code: "notReady", problems: [{ code: "trashed", template: true }] },
      });
      // The trashed template cannot be chosen again; another one can.
      const choose = (templateId: string, expectedRowVersion: number) =>
        asUser(database, USER_A, (tx) =>
          updateAssessment(tx, {
            ownerId: USER_A,
            assessmentId: s.assessmentId,
            input: { ...ASSESSMENT_INPUT, title: "Ulangan Bab 1", templateId },
            expectedRowVersion,
          }),
        );
      expect(await choose(s.templateId, 1)).toEqual({
        ok: false,
        error: "templateNotFound",
      });
      expect(await choose(replacement, 1)).toMatchObject({ ok: true });
      expect(await approveNow()).toMatchObject({ ok: true });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "cannot be chosen for a new assessment",
    async () => {
      const store = listingStore();
      const templateId = await seedTemplate(store, USER_A, { isDefault: true });
      await trash(USER_A, templateId);
      const created = await asUser(database, USER_A, (tx) =>
        createAssessment(tx, {
          ownerId: USER_A,
          input: { ...ASSESSMENT_INPUT, templateId },
        }),
      );
      expect(created).toEqual({ ok: false, error: "templateNotFound" });
    },
    DB_TEST_TIMEOUT,
  );
});

describe("deleteTemplatePermanently", () => {
  it(
    "deletes the template and its logo, and nothing of another template or teacher",
    async () => {
      const store = listingStore();
      const templateId = await seedTemplate(store, USER_A, { logo: true });
      const sibling = await seedTemplate(store, USER_A, { name: "Lain", logo: true });
      const foreign = await seedTemplate(store, USER_B, { logo: true });
      await trash(USER_A, templateId);
      expect(
        await deleteTemplatePermanently(db(), () => store, {
          ownerId: USER_A,
          templateId,
          now: NOW,
        }),
      ).toEqual({ ok: true, data: { logoFiles: 1 } });
      expect(await rowOf(templateId)).toBeUndefined();
      expect(store.deletedPrefixes).toEqual([`templates/${USER_A}/${templateId}/`]);
      expect(store.keys()).toEqual(
        [
          `templates/${USER_A}/${sibling}/logo.png`,
          `templates/${USER_B}/${foreign}/logo.png`,
        ].sort(),
      );
      const log = await database.db.select().from(deletionLog);
      expect(
        log.map((row) => [row.ownerId, row.entity, row.entityId, row.counts]),
      ).toEqual([[USER_A, "template", templateId, { templates: 1, logos: 1 }]]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "deletes only the template's own prefix even when logo_key names another teacher's object",
    async () => {
      const store = listingStore();
      const foreign = await seedTemplate(store, USER_B, { logo: true });
      const templateId = await seedTemplate(store, USER_A);
      await database.db
        .update(schoolTemplates)
        .set({ logoKey: `templates/${USER_B}/${foreign}/logo.png` })
        .where(eq(schoolTemplates.id, templateId));
      await trash(USER_A, templateId);
      expect(
        await deleteTemplatePermanently(db(), () => store, {
          ownerId: USER_A,
          templateId,
          now: NOW,
        }),
      ).toEqual({ ok: true, data: { logoFiles: 0 } });
      expect(store.deletedPrefixes).toEqual([`templates/${USER_A}/${templateId}/`]);
      expect(store.keys()).toEqual([`templates/${USER_B}/${foreign}/logo.png`]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses while an assessment (even a trashed one) uses it, naming the assessments",
    async () => {
      const store = listingStore();
      const s = await seedApprovedAssessment(database, {
        ownerId: USER_A,
        title: "Ulangan Bab 1",
      });
      await trash(USER_A, s.templateId);
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        now: NOW,
      });
      const noStore = vi.fn(() => store);
      expect(
        await deleteTemplatePermanently(db(), noStore, {
          ownerId: USER_A,
          templateId: s.templateId,
          now: NOW,
        }),
      ).toEqual({ ok: false, error: { code: "inUse", assessments: ["Ulangan Bab 1"] } });
      expect(noStore).not.toHaveBeenCalled();
      expect(await rowOf(s.templateId)).toBeDefined();
      expect(await database.db.select().from(deletionLog)).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses a template that is not in the trash, and another teacher's",
    async () => {
      const store = listingStore();
      const templateId = await seedTemplate(store, USER_A, { logo: true });
      expect(
        await deleteTemplatePermanently(db(), () => store, {
          ownerId: USER_A,
          templateId,
          now: NOW,
        }),
      ).toEqual({ ok: false, error: "notInTrash" });
      await trash(USER_A, templateId);
      expect(
        await deleteTemplatePermanently(db(), () => store, {
          ownerId: USER_B,
          templateId,
          now: NOW,
        }),
      ).toEqual({ ok: false, error: "notFound" });
      expect(await rowOf(templateId)).toBeDefined();
      expect(store.keys()).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "keeps the row when the logo cannot be deleted, so the logo is never orphaned",
    async () => {
      const failing = { on: true };
      const store = listingStore({ failPrefix: () => failing.on });
      const templateId = await seedTemplate(store, USER_A, { logo: true });
      await trash(USER_A, templateId);
      await expect(
        deleteTemplatePermanently(db(), () => store, {
          ownerId: USER_A,
          templateId,
          now: NOW,
        }),
      ).rejects.toThrow("storage unavailable");
      expect((await rowOf(templateId))?.logoKey).toBe(
        `templates/${USER_A}/${templateId}/logo.png`,
      );
      expect(store.keys()).toHaveLength(1);
      failing.on = false;
      expect(
        await deleteTemplatePermanently(db(), () => store, {
          ownerId: USER_A,
          templateId,
          now: NOW,
        }),
      ).toEqual({ ok: true, data: { logoFiles: 1 } });
      expect(store.keys()).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("deleteTemplatePermanently without a recorded logo", () => {
  it(
    "still clears the template's own prefix (an upload whose row write failed)",
    async () => {
      const store = listingStore();
      const templateId = await seedTemplate(store, USER_A);
      const stray = `templates/${USER_A}/${templateId}/logo.png`;
      await store.put(stray, new Uint8Array([1]), "image/png");
      await trash(USER_A, templateId);
      expect(
        await deleteTemplatePermanently(db(), () => store, {
          ownerId: USER_A,
          templateId,
          now: NOW,
        }),
      ).toEqual({ ok: true, data: { logoFiles: 1 } });
      expect(store.keys()).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("purgeExpiredTemplates", () => {
  it(
    "purges expired unused templates, skips one in use, isolates a failure and is idempotent",
    async () => {
      const failOn = { prefix: "none" };
      const store = listingStore({
        failPrefix: (prefix) => prefix.includes(failOn.prefix),
      });
      const old = await seedTemplate(store, USER_A, { name: "Lama", logo: true });
      const young = await seedTemplate(store, USER_A, { name: "Muda" });
      const failing = await seedTemplate(store, USER_B, { name: "Gagal", logo: true });
      const s = await seedApprovedAssessment(database, { ownerId: USER_B });
      failOn.prefix = failing;
      await trash(USER_A, old);
      await trash(USER_B, failing);
      await trash(USER_B, s.templateId);
      await trash(USER_A, young, new Date(NOW.getTime() + 5 * DAY_MS));

      const day30 = new Date(NOW.getTime() + 30 * DAY_MS);
      const errors = vi.spyOn(logger, "error").mockImplementation(() => undefined);
      const infos = vi.spyOn(logger, "info").mockImplementation(() => undefined);
      expect(await purgeExpiredTemplates(db(), () => store, day30)).toEqual({
        purged: 1,
        failed: 1,
      });
      expect(errors.mock.calls).toEqual([
        [
          { module: "trash", templateId: failing, err: { name: "Error", code: null } },
          "trash: could not purge a template",
        ],
      ]);
      // Kept rows are counted once per run, ids and content left out.
      expect(infos.mock.calls).toEqual([
        [
          { module: "trash", blockedTemplates: 1 },
          "trash: expired templates still used by an assessment are kept",
        ],
      ]);
      errors.mockRestore();
      infos.mockRestore();
      expect(await rowOf(old)).toBeUndefined();
      expect(await rowOf(failing)).toBeDefined();
      expect(await rowOf(s.templateId)).toBeDefined();
      expect(await rowOf(young)).toBeDefined();

      failOn.prefix = "none";
      expect(await purgeExpiredTemplates(db(), () => store, day30)).toEqual({
        purged: 1,
        failed: 0,
      });
      expect(await purgeExpiredTemplates(db(), () => store, day30)).toEqual({
        purged: 0,
        failed: 0,
      });
      expect(store.keys()).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("purgeExpiredTemplates with a full batch of templates in use", () => {
  it(
    "never lets kept templates starve an expired free one behind them",
    async () => {
      const store = listingStore();
      const blocked: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const templateId = await seedTemplate(store, USER_A, {
          name: `Dipakai ${String(i)}`,
        });
        await database.db.insert(assessments).values({
          ownerId: USER_A,
          title: `Asesmen ${String(i)}`,
          grade: 8,
          templateId,
        });
        // Trashed earlier, so they come first in purge order.
        await trash(USER_A, templateId, new Date(NOW.getTime() - DAY_MS));
        blocked.push(templateId);
      }
      const free = await seedTemplate(store, USER_A, { name: "Bebas" });
      await trash(USER_A, free);
      vi.spyOn(logger, "info").mockImplementation(() => undefined);
      try {
        expect(
          await purgeExpiredTemplates(
            db(),
            () => store,
            new Date(NOW.getTime() + 30 * DAY_MS),
            { batch: 2 },
          ),
        ).toEqual({ purged: 1, failed: 0 });
      } finally {
        vi.restoreAllMocks();
      }
      expect(await rowOf(free)).toBeUndefined();
      for (const id of blocked) expect(await rowOf(id)).toBeDefined();
    },
    DB_TEST_TIMEOUT,
  );
});

describe("purgeTrashOncePerDay", () => {
  it(
    "purges an expired assessment before its expired template, in one daily run",
    async () => {
      const store = listingStore();
      const s = await seedApprovedAssessment(database, { ownerId: USER_A });
      await trash(USER_A, s.templateId);
      await trashAssessment(db(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        now: NOW,
      });
      expect(
        await purgeTrashOncePerDay(
          db(),
          new Date(NOW.getTime() + 30 * DAY_MS),
          () => store,
        ),
      ).toEqual({ purged: 2, failed: 0 });
      expect(await rowOf(s.templateId)).toBeUndefined();
      expect(
        (await database.db.select().from(deletionLog)).map((row) => row.entity).sort(),
      ).toEqual(["assessment", "template"]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("listTrashedTemplates", () => {
  it(
    "lists the owner's trashed templates only, with the assessments that still use them",
    async () => {
      const store = listingStore();
      const s = await seedApprovedAssessment(database, {
        ownerId: USER_A,
        title: "Ulangan Bab 1",
      });
      const plain = await seedTemplate(store, USER_A, { name: "Polos", logo: true });
      const foreign = await seedTemplate(store, USER_B);
      await trash(USER_A, plain);
      await trash(USER_A, s.templateId, new Date(NOW.getTime() + DAY_MS));
      await trash(USER_B, foreign);
      const listed = await asUser(database, USER_A, (tx) =>
        listTrashedTemplates(tx, {
          ownerId: USER_A,
          now: new Date(NOW.getTime() + DAY_MS),
        }),
      );
      expect(listed).toEqual([
        {
          templateId: s.templateId,
          name: "Standar",
          schoolName: "SMP Negeri 1 Contoh",
          hasLogo: false,
          usedBy: ["Ulangan Bab 1"],
          deletedAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
          purgeAfter: new Date(NOW.getTime() + 31 * DAY_MS).toISOString(),
          daysLeft: 30,
        },
        {
          templateId: plain,
          name: "Polos",
          schoolName: "SMP Negeri 1 Contoh",
          hasLogo: true,
          usedBy: [],
          deletedAt: NOW.toISOString(),
          purgeAfter: new Date(NOW.getTime() + 30 * DAY_MS).toISOString(),
          daysLeft: 29,
        },
      ]);
    },
    DB_TEST_TIMEOUT,
  );
});
