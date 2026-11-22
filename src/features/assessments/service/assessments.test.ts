import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser } from "@/lib/db/client";
import { assessments, assessmentSections, schoolTemplates } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { seedCurriculum } from "@/features/generation";
import { ASSESSMENT_INPUT, clearAll, seedBankedQuestions } from "../test-support";
import type { AssessmentInput } from "../schema/assessment";
import {
  createAssessment,
  getAssessmentEditor,
  listAssessments,
  updateAssessment,
  type AssessmentDb,
} from "./assessments";
import { addItems } from "./items";

let database: TestDatabase;
const db = () => database.db as unknown as AssessmentDb;

const INPUT: AssessmentInput = {
  ...ASSESSMENT_INPUT,
  title: "Ulangan SPLDV",
  kind: "ulangan_harian",
  examDate: "2026-12-01",
  durationMinutes: 60,
  instructions: "Kerjakan dengan teliti.",
};

const asUser = <T>(userId: string, fn: (tx: AssessmentDb) => Promise<T>) =>
  runAsUser(db(), userId, (tx) => fn(tx as unknown as AssessmentDb));

async function create(ownerId: string, input: Partial<AssessmentInput> = {}) {
  const created = await asUser(ownerId, (tx) =>
    createAssessment(tx, { ownerId, input: { ...INPUT, ...input } }),
  );
  if (!created.ok) throw new Error(created.error);
  return created.data;
}

async function template(ownerId: string, isDefault = false) {
  const [row] = await database.db
    .insert(schoolTemplates)
    .values({ ownerId, name: "Kop", schoolName: "SMP 1", isDefault })
    .returning({ id: schoolTemplates.id });
  return row.id;
}

const load = async (id: string) =>
  (await database.db.select().from(assessments).where(eq(assessments.id, id)))[0];

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await clearAll(database);
});

describe("createAssessment", () => {
  it("creates a draft with the given fields and one default section", async () => {
    const { id, sectionId } = await create(USER_A);
    expect(await load(id)).toMatchObject({
      ownerId: USER_A,
      title: "Ulangan SPLDV",
      kind: "ulangan_harian",
      grade: 8,
      examDate: "2026-12-01",
      durationMinutes: 60,
      instructionsMd: "Kerjakan dengan teliti.",
      status: "draft",
      scoringMode: "equal",
      shuffleSeed: null,
      rowVersion: 1,
      deletedAt: null,
    });
    const sections = await database.db
      .select()
      .from(assessmentSections)
      .where(eq(assessmentSections.assessmentId, id));
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      id: sectionId,
      title: "A. Pilihan ganda",
      sortOrder: 0,
      ownerId: USER_A,
    });
  });

  it("uses the chosen template, or else the teacher's own default template", async () => {
    const own = await template(USER_A);
    const chosen = await create(USER_A, { templateId: own });
    expect((await load(chosen.id)).templateId).toBe(own);

    const noDefault = await create(USER_A);
    expect((await load(noDefault.id)).templateId).toBeNull();

    await template(USER_B, true);
    const mine = await template(USER_A, true);
    const implicit = await create(USER_A);
    expect((await load(implicit.id)).templateId).toBe(mine);
  });

  it("refuses another teacher's template and a trashed one, creating nothing", async () => {
    const foreign = await template(USER_B);
    const mine = await template(USER_A);
    await database.db
      .update(schoolTemplates)
      .set({ deletedAt: new Date() })
      .where(eq(schoolTemplates.id, mine));
    for (const templateId of [foreign, mine]) {
      const result = await asUser(USER_A, (tx) =>
        createAssessment(tx, { ownerId: USER_A, input: { ...INPUT, templateId } }),
      );
      expect(result).toEqual({ ok: false, error: "templateNotFound" });
    }
    expect(await database.db.select().from(assessments)).toHaveLength(0);
  });
});

describe("updateAssessment", () => {
  const update = (
    ownerId: string,
    assessmentId: string,
    input: Partial<AssessmentInput> = {},
    expectedRowVersion = 1,
  ) =>
    asUser(ownerId, (tx) =>
      updateAssessment(tx, {
        ownerId,
        assessmentId,
        expectedRowVersion,
        input: { ...INPUT, ...input },
      }),
    );

  it("updates the fields, bumps the row version and keeps the status", async () => {
    const { id } = await create(USER_A);
    const result = await update(USER_A, id, {
      title: "STS ganjil",
      kind: "sts",
      durationMinutes: null,
    });
    expect(result).toEqual({ ok: true, data: { rowVersion: 2 } });
    expect(await load(id)).toMatchObject({
      title: "STS ganjil",
      kind: "sts",
      durationMinutes: null,
      status: "draft",
      rowVersion: 2,
    });
  });

  it("refuses a stale row version", async () => {
    const { id } = await create(USER_A);
    expect(await update(USER_A, id, {}, 5)).toEqual({ ok: false, error: "conflict" });
  });

  it("refuses an approved assessment, whatever the row version", async () => {
    const { id } = await create(USER_A);
    await database.db
      .update(assessments)
      .set({ status: "approved", approvedAt: new Date(), approvedSnapshotHash: "h" })
      .where(eq(assessments.id, id));
    expect(await update(USER_A, id, { title: "Diubah" })).toEqual({
      ok: false,
      error: "approved",
    });
    expect((await load(id)).title).toBe("Ulangan SPLDV");
  });

  it("is notFound for another teacher's, a trashed, an unknown and a malformed id", async () => {
    const { id } = await create(USER_A);
    const trashed = await create(USER_A);
    await database.db
      .update(assessments)
      .set({ deletedAt: new Date() })
      .where(eq(assessments.id, trashed.id));
    const notFound = { ok: false, error: "notFound" };
    expect(await update(USER_B, id, { title: "Dibajak" })).toEqual(notFound);
    expect(await update(USER_A, trashed.id)).toEqual(notFound);
    expect(await update(USER_A, "00000000-0000-4000-8000-000000000000")).toEqual(
      notFound,
    );
    expect(await update(USER_A, "not-a-uuid")).toEqual(notFound);
    expect((await load(id)).title).toBe("Ulangan SPLDV");
  });

  it("refuses another teacher's template", async () => {
    const { id } = await create(USER_A);
    const foreign = await template(USER_B);
    expect(await update(USER_A, id, { templateId: foreign })).toEqual({
      ok: false,
      error: "templateNotFound",
    });
  });
});

describe("listAssessments", () => {
  it("lists the owner's assessments, newest first, with status and counts, without trashed ones", async () => {
    const curriculum = await seedCurriculum(database.db);
    const questionIds = await seedBankedQuestions(database, {
      ownerId: USER_A,
      count: 2,
      curriculum,
    });
    const first = await create(USER_A, { title: "Pertama" });
    const second = await create(USER_A, { title: "Kedua" });
    const trashed = await create(USER_A, { title: "Dibuang" });
    await create(USER_B, { title: "Milik B" });
    await asUser(USER_A, (tx) =>
      addItems(tx, {
        ownerId: USER_A,
        assessmentId: first.id,
        sectionId: first.sectionId,
        questionIds,
      }),
    );
    await database.db.insert(assessmentSections).values({
      ownerId: USER_A,
      assessmentId: first.id,
      title: "B. Uraian",
      sortOrder: 1,
    });
    await database.db
      .update(assessments)
      .set({ status: "approved", approvedAt: new Date(), approvedSnapshotHash: "h" })
      .where(eq(assessments.id, second.id));
    await database.db
      .update(assessments)
      .set({ deletedAt: new Date() })
      .where(eq(assessments.id, trashed.id));
    await database.db.execute(
      sql`update assessments set updated_at = '2026-01-01T00:00:00Z' where id = ${first.id}`,
    );
    await database.db.execute(
      sql`update assessments set updated_at = '2026-02-01T00:00:00Z' where id = ${second.id}`,
    );

    const list = await asUser(USER_A, (tx) => listAssessments(tx, USER_A));
    expect(list.map((row) => row.title)).toEqual(["Kedua", "Pertama"]);
    expect(list[0]).toMatchObject({
      id: second.id,
      status: "approved",
      kind: "ulangan_harian",
      grade: 8,
      itemCount: 0,
      sectionCount: 1,
    });
    expect(list[1]).toMatchObject({
      id: first.id,
      status: "draft",
      itemCount: 2,
      sectionCount: 2,
    });
  });

  it("never lists another teacher's assessments", async () => {
    await create(USER_B, { title: "Milik B" });
    expect(await asUser(USER_A, (tx) => listAssessments(tx, USER_A))).toEqual([]);
    expect(await asUser(USER_B, (tx) => listAssessments(tx, USER_B))).toHaveLength(1);
  });
});

describe("getAssessmentEditor", () => {
  it("returns the assessment and its sections in order; null for foreign, trashed or malformed ids", async () => {
    const { id } = await create(USER_A);
    await database.db.insert(assessmentSections).values({
      ownerId: USER_A,
      assessmentId: id,
      title: "B. Uraian",
      sortOrder: 1,
    });
    const read = (ownerId: string, assessmentId: string) =>
      asUser(ownerId, (tx) => getAssessmentEditor(tx, { ownerId, assessmentId }));

    const view = await read(USER_A, id);
    expect(view?.assessment).toMatchObject({
      id,
      title: "Ulangan SPLDV",
      status: "draft",
      rowVersion: 1,
      examDate: "2026-12-01",
      durationMinutes: 60,
      instructions: "Kerjakan dengan teliti.",
    });
    expect(view?.sections.map((s) => s.title)).toEqual(["A. Pilihan ganda", "B. Uraian"]);

    expect(await read(USER_B, id)).toBeNull();
    expect(await read(USER_A, "nope")).toBeNull();
    await database.db
      .update(assessments)
      .set({ deletedAt: new Date() })
      .where(eq(assessments.id, id));
    expect(await read(USER_A, id)).toBeNull();
  });
});
