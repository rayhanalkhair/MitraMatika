import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  holder: { db: {} },
}));

vi.mock("@/features/auth/service/guard", () => ({
  authorizeAction: mocks.authorizeAction,
}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => mocks.holder.db }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { seedCurriculum } from "@/features/generation";
import {
  assessmentItems,
  assessments,
  assessmentSections,
  schoolTemplates,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { clearAll, seedBankedQuestions } from "../test-support";
import { createAssessmentAction } from "./create-assessment";
import {
  addItemsAction,
  moveItemAction,
  removeItemAction,
  updateItemToLatestAction,
} from "./edit-items";
import {
  addSectionAction,
  removeSectionAction,
  renameSectionAction,
} from "./edit-sections";
import { updateAssessmentAction } from "./update-assessment";

let database: TestDatabase;
const asUser = (userId: string) =>
  mocks.authorizeAction.mockResolvedValue({
    ok: true,
    data: { status: "allowed", userId, email: "t@example.test", displayName: null },
  });

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};
const FORM = {
  title: "Ulangan",
  kind: "latihan",
  grade: "8",
  templateId: "",
  examDate: "",
  durationMinutes: "",
  instructions: "",
};

// Teacher A's assessment with two sections and two pinned items; teacher B's question.
async function seed() {
  const curriculum = await seedCurriculum(database.db);
  const a = await seedBankedQuestions(database, {
    ownerId: USER_A,
    count: 3,
    curriculum,
  });
  const b = await seedBankedQuestions(database, {
    ownerId: USER_B,
    count: 1,
    curriculum,
  });
  asUser(USER_A);
  await expect(createAssessmentAction({}, form(FORM))).rejects.toThrow("NEXT_REDIRECT");
  const [assessment] = await database.db.select().from(assessments);
  const [first] = await database.db.select().from(assessmentSections);
  const added = await addSectionAction({
    assessmentId: assessment.id,
    title: "B. Uraian",
  });
  if (!added.ok) throw new Error(added.reason);
  const items = await addItemsAction({
    assessmentId: assessment.id,
    sectionId: first.id,
    questionIds: [a[0], a[1]],
  });
  if (!items.ok) throw new Error(items.reason);
  const rows = await database.db
    .select()
    .from(assessmentItems)
    .orderBy(asc(assessmentItems.sortOrder));
  return {
    a,
    b,
    assessmentId: assessment.id,
    rowVersion: assessment.rowVersion,
    first: first.id,
    second: added.id,
    itemId: rows[0].id,
  };
}

const sectionsOf = (assessmentId: string) =>
  database.db
    .select()
    .from(assessmentSections)
    .where(eq(assessmentSections.assessmentId, assessmentId));

beforeAll(async () => {
  database = await createTestDatabase();
  mocks.holder.db = database.db;
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await clearAll(database);
  asUser(USER_A);
});

describe("every action refuses a signed-out caller and touches nothing", () => {
  it("returns unauthenticated", async () => {
    const s = await seed();
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    const id = s.assessmentId;
    const results = await Promise.all([
      createAssessmentAction({}, form(FORM)),
      updateAssessmentAction(
        {},
        form({ ...FORM, assessmentId: id, expectedRowVersion: "1" }),
      ),
      addItemsAction({ assessmentId: id, sectionId: s.first, questionIds: [s.a[2]] }),
      removeItemAction({ itemId: s.itemId }),
      moveItemAction({ itemId: s.itemId, toSectionId: s.second, toIndex: 0 }),
      updateItemToLatestAction({ itemId: s.itemId }),
      addSectionAction({ assessmentId: id, title: "X" }),
      renameSectionAction({ sectionId: s.first, title: "X" }),
      removeSectionAction({ sectionId: s.second }),
    ]);
    expect(results[0]).toEqual({ error: "unauthenticated" });
    expect(results[1]).toEqual({ error: "unauthenticated" });
    for (const result of results.slice(2)) {
      expect(result).toEqual({ ok: false, reason: "unauthenticated" });
    }
    expect(await database.db.select().from(assessments)).toHaveLength(1);
    expect(await database.db.select().from(assessmentItems)).toHaveLength(2);
    expect(await sectionsOf(id)).toHaveLength(2);
  });
});

describe("another teacher cannot use any action on a teacher's assessment", () => {
  it("is notFound everywhere and changes nothing", async () => {
    const s = await seed();
    asUser(USER_B);
    const id = s.assessmentId;
    const update = await updateAssessmentAction(
      {},
      form({ ...FORM, title: "Dibajak", assessmentId: id, expectedRowVersion: "1" }),
    );
    expect(update).toEqual({ error: "notFound" });
    const results = await Promise.all([
      addItemsAction({ assessmentId: id, sectionId: s.first, questionIds: s.b }),
      removeItemAction({ itemId: s.itemId }),
      moveItemAction({ itemId: s.itemId, toSectionId: s.second, toIndex: 0 }),
      updateItemToLatestAction({ itemId: s.itemId }),
      addSectionAction({ assessmentId: id, title: "X" }),
      renameSectionAction({ sectionId: s.first, title: "Dibajak" }),
      removeSectionAction({ sectionId: s.second }),
    ]);
    for (const result of results)
      expect(result).toEqual({ ok: false, reason: "notFound" });

    const [row] = await database.db.select().from(assessments);
    expect(row).toMatchObject({ title: "Ulangan", rowVersion: 1 });
    expect(await database.db.select().from(assessmentItems)).toHaveLength(2);
    expect((await sectionsOf(id)).map((r) => r.title).sort()).toEqual([
      "A. Pilihan ganda",
      "B. Uraian",
    ]);
  });

  it("cannot create an assessment with another teacher's template", async () => {
    asUser(USER_B);
    const [template] = await database.db
      .insert(schoolTemplates)
      .values({ ownerId: USER_A, name: "Kop", schoolName: "SMP" })
      .returning({ id: schoolTemplates.id });
    const state = await createAssessmentAction(
      {},
      form({ ...FORM, templateId: template.id }),
    );
    expect(state).toEqual({ error: "templateNotFound" });
    expect(await database.db.select().from(assessments)).toHaveLength(0);
  });
});

describe("createAssessmentAction", () => {
  it("creates for the signed-in teacher and goes to the editor", async () => {
    asUser(USER_A);
    await expect(
      createAssessmentAction({}, form({ ...FORM, ownerId: USER_B })),
    ).rejects.toThrow(/NEXT_REDIRECT:\/assessment-builder\/[0-9a-f-]{36}/);
    const [row] = await database.db.select().from(assessments);
    expect(row.ownerId).toBe(USER_A);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/assessment-builder", "layout");
  });

  it("returns the field errors of an invalid form and creates nothing", async () => {
    const state = await createAssessmentAction(
      {},
      form({ ...FORM, title: "  ", grade: "6", durationMinutes: "0" }),
    );
    expect(state).toEqual({
      fieldErrors: { title: "required", grade: "invalid", durationMinutes: "invalid" },
    });
    expect(await database.db.select().from(assessments)).toHaveLength(0);
  });
});

describe("updateAssessmentAction", () => {
  it("saves with the row version of the form and reports a stale one", async () => {
    const s = await seed();
    const ok = await updateAssessmentAction(
      {},
      form({
        ...FORM,
        title: "Baru",
        assessmentId: s.assessmentId,
        expectedRowVersion: String(s.rowVersion),
      }),
    );
    expect(ok.savedAt).toEqual(expect.any(Number));
    const stale = await updateAssessmentAction(
      {},
      form({
        ...FORM,
        title: "Lagi",
        assessmentId: s.assessmentId,
        expectedRowVersion: String(s.rowVersion),
      }),
    );
    expect(stale).toEqual({ error: "conflict" });
    const [row] = await database.db.select().from(assessments);
    expect(row.title).toBe("Baru");
  });

  it("refuses malformed ids and versions", async () => {
    const s = await seed();
    expect(
      await updateAssessmentAction(
        {},
        form({ ...FORM, assessmentId: "nope", expectedRowVersion: "1" }),
      ),
    ).toEqual({ error: "notFound" });
    expect(
      await updateAssessmentAction(
        {},
        form({ ...FORM, assessmentId: s.assessmentId, expectedRowVersion: "x" }),
      ),
    ).toEqual({ error: "conflict" });
  });
});

describe("the item and section actions", () => {
  it("add, move, remove and update items for the owner", async () => {
    const s = await seed();
    const dup = await addItemsAction({
      assessmentId: s.assessmentId,
      sectionId: s.second,
      questionIds: [s.a[0], s.a[2]],
    });
    expect(dup).toEqual({ ok: true, added: 1, skipped: 1 });
    expect(
      await moveItemAction({ itemId: s.itemId, toSectionId: s.second, toIndex: 0 }),
    ).toEqual({ ok: true });
    expect(await updateItemToLatestAction({ itemId: s.itemId })).toEqual({
      ok: true,
      changed: false,
    });
    expect(await removeItemAction({ itemId: s.itemId })).toEqual({ ok: true });
    expect(await database.db.select().from(assessmentItems)).toHaveLength(2);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/assessment-builder", "layout");
  });

  it("refuses another teacher's question as notBanked", async () => {
    const s = await seed();
    expect(
      await addItemsAction({
        assessmentId: s.assessmentId,
        sectionId: s.first,
        questionIds: s.b,
      }),
    ).toEqual({ ok: false, reason: "notBanked", questionId: s.b[0] });
  });

  it("validates ids, the section title and the list before touching the database", async () => {
    const s = await seed();
    expect(
      await addItemsAction({ assessmentId: "x", sectionId: s.first, questionIds: [] }),
    ).toEqual({ ok: false, reason: "invalid" });
    // More ids than one call may carry is a typed refusal from the service, not a crash.
    expect(
      await addItemsAction({
        assessmentId: s.assessmentId,
        sectionId: s.first,
        questionIds: Array.from({ length: 51 }, () => s.a[0]),
      }),
    ).toEqual({ ok: false, reason: "tooManyAtOnce" });
    // The argument comes from the client: anything that is not an object is refused.
    for (const bad of [null, undefined, "x", 3]) {
      const input = bad as never;
      for (const result of await Promise.all([
        addItemsAction(input),
        removeItemAction(input),
        moveItemAction(input),
        updateItemToLatestAction(input),
        addSectionAction(input),
        renameSectionAction(input),
        removeSectionAction(input),
      ])) {
        expect(result).toEqual({ ok: false, reason: "invalid" });
      }
    }
    expect(await removeItemAction({ itemId: "x" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(
      await moveItemAction({ itemId: s.itemId, toSectionId: s.second, toIndex: 1.5 }),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(await addSectionAction({ assessmentId: s.assessmentId, title: " " })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(
      await renameSectionAction({ sectionId: s.first, title: "a".repeat(81) }),
    ).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await removeSectionAction({ sectionId: "x" })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rename and remove a section; the last one stays", async () => {
    const s = await seed();
    expect(await renameSectionAction({ sectionId: s.first, title: " A. PG " })).toEqual({
      ok: true,
    });
    expect(await removeSectionAction({ sectionId: s.first })).toEqual({ ok: true });
    expect(await removeSectionAction({ sectionId: s.second })).toEqual({
      ok: false,
      reason: "lastSection",
    });
    const rows = await database.db.select().from(assessmentItems);
    expect(rows.every((row) => row.sectionId === s.second)).toBe(true);
  });

  it("refuses every write on an approved assessment", async () => {
    const s = await seed();
    await database.db
      .update(assessments)
      .set({ status: "approved", approvedAt: new Date(), approvedSnapshotHash: "h" });
    const results = await Promise.all([
      addItemsAction({
        assessmentId: s.assessmentId,
        sectionId: s.first,
        questionIds: [s.a[2]],
      }),
      removeItemAction({ itemId: s.itemId }),
      moveItemAction({ itemId: s.itemId, toSectionId: s.second, toIndex: 0 }),
      updateItemToLatestAction({ itemId: s.itemId }),
      addSectionAction({ assessmentId: s.assessmentId, title: "X" }),
      renameSectionAction({ sectionId: s.first, title: "X" }),
      removeSectionAction({ sectionId: s.second }),
    ]);
    for (const result of results)
      expect(result).toEqual({ ok: false, reason: "approved" });
    const update = await updateAssessmentAction(
      {},
      form({
        ...FORM,
        assessmentId: s.assessmentId,
        expectedRowVersion: String(s.rowVersion),
      }),
    );
    expect(update).toEqual({ error: "approved" });
  });
});
