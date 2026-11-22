import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser } from "@/lib/db/client";
import { assessmentItems, assessments, assessmentSections } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { seedCurriculum } from "@/features/generation";
import { ASSESSMENT_INPUT, clearAll, seedBankedQuestions } from "../test-support";
import { createAssessment, type AssessmentDb } from "./assessments";
import { addItems } from "./items";
import { addSection, MAX_SECTIONS, removeSection, renameSection } from "./sections";

let database: TestDatabase;
const db = () => database.db as unknown as AssessmentDb;
const asUser = <T>(userId: string, fn: (tx: AssessmentDb) => Promise<T>) =>
  runAsUser(db(), userId, (tx) => fn(tx as unknown as AssessmentDb));

async function seed() {
  const curriculum = await seedCurriculum(database.db);
  const questionIds = await seedBankedQuestions(database, {
    ownerId: USER_A,
    count: 4,
    curriculum,
  });
  const created = await asUser(USER_A, async (tx) => {
    const r = await createAssessment(tx, { ownerId: USER_A, input: ASSESSMENT_INPUT });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  });
  return { questionIds, assessmentId: created.id, first: created.sectionId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const sections = (assessmentId: string) =>
  database.db
    .select()
    .from(assessmentSections)
    .where(eq(assessmentSections.assessmentId, assessmentId))
    .orderBy(asc(assessmentSections.sortOrder));

const mk = async (s: Seed, title: string) => {
  const r = await asUser(USER_A, (tx) =>
    addSection(tx, { ownerId: USER_A, assessmentId: s.assessmentId, title }),
  );
  if (!r.ok) throw new Error(r.error);
  return r.data.id;
};

const lock = (s: Seed) =>
  database.db
    .update(assessments)
    .set({ status: "approved", approvedAt: new Date(), approvedSnapshotHash: "h" })
    .where(eq(assessments.id, s.assessmentId));

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await clearAll(database);
});

describe("addSection", () => {
  it("appends a section with the next sort order", async () => {
    const s = await seed();
    await mk(s, "B. Uraian");
    await mk(s, "C. Isian");
    expect((await sections(s.assessmentId)).map((r) => [r.title, r.sortOrder])).toEqual([
      ["A. Pilihan ganda", 0],
      ["B. Uraian", 1],
      ["C. Isian", 2],
    ]);
  });

  it("stops at the section limit", async () => {
    const s = await seed();
    for (let i = 1; i < MAX_SECTIONS; i += 1) await mk(s, `Bagian ${String(i)}`);
    const result = await asUser(USER_A, (tx) =>
      addSection(tx, { ownerId: USER_A, assessmentId: s.assessmentId, title: "Lagi" }),
    );
    expect(result).toEqual({ ok: false, error: "tooMany" });
  });

  it("is notFound for another teacher's assessment and refused once approved", async () => {
    const s = await seed();
    expect(
      await asUser(USER_B, (tx) =>
        addSection(tx, { ownerId: USER_B, assessmentId: s.assessmentId, title: "X" }),
      ),
    ).toEqual({ ok: false, error: "notFound" });
    await lock(s);
    expect(
      await asUser(USER_A, (tx) =>
        addSection(tx, { ownerId: USER_A, assessmentId: s.assessmentId, title: "X" }),
      ),
    ).toEqual({ ok: false, error: "approved" });
    expect(await sections(s.assessmentId)).toHaveLength(1);
  });
});

describe("renameSection", () => {
  it("renames the section", async () => {
    const s = await seed();
    expect(
      await asUser(USER_A, (tx) =>
        renameSection(tx, { ownerId: USER_A, sectionId: s.first, title: "A. PG" }),
      ),
    ).toEqual({ ok: true, data: undefined });
    expect((await sections(s.assessmentId))[0].title).toBe("A. PG");
  });

  it("is notFound for a foreign or malformed id and refused once approved", async () => {
    const s = await seed();
    expect(
      await asUser(USER_B, (tx) =>
        renameSection(tx, { ownerId: USER_B, sectionId: s.first, title: "Dibajak" }),
      ),
    ).toEqual({ ok: false, error: "notFound" });
    expect(
      await asUser(USER_A, (tx) =>
        renameSection(tx, { ownerId: USER_A, sectionId: "nope", title: "X" }),
      ),
    ).toEqual({ ok: false, error: "notFound" });
    await lock(s);
    expect(
      await asUser(USER_A, (tx) =>
        renameSection(tx, { ownerId: USER_A, sectionId: s.first, title: "X" }),
      ),
    ).toEqual({ ok: false, error: "approved" });
    expect((await sections(s.assessmentId))[0].title).toBe("A. Pilihan ganda");
  });
});

describe("removeSection", () => {
  const place = async (s: Seed) => {
    const rows = await database.db
      .select()
      .from(assessmentItems)
      .where(eq(assessmentItems.assessmentId, s.assessmentId));
    const result = new Map<string, number[]>();
    for (const row of rows.sort((x, y) => x.sortOrder - y.sortOrder)) {
      result.set(row.sectionId, [
        ...(result.get(row.sectionId) ?? []),
        s.questionIds.indexOf(row.questionId),
      ]);
    }
    return result;
  };
  const addTo = async (s: Seed, sectionId: string, indexes: number[]) => {
    const r = await asUser(USER_A, (tx) =>
      addItems(tx, {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        sectionId,
        questionIds: indexes.map((i) => s.questionIds[i]),
      }),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  };
  const remove = (ownerId: string, sectionId: string) =>
    asUser(ownerId, (tx) => removeSection(tx, { ownerId, sectionId }));

  it("moves the items to the end of the previous section and renumbers the sections", async () => {
    const s = await seed();
    const second = await mk(s, "B");
    const third = await mk(s, "C");
    await addTo(s, s.first, [0]);
    await addTo(s, second, [1, 2]);
    await addTo(s, third, [3]);
    expect(await remove(USER_A, second)).toEqual({ ok: true, data: undefined });
    const placed = await place(s);
    expect(placed.get(s.first)).toEqual([0, 1, 2]);
    expect(placed.get(third)).toEqual([3]);
    expect(placed.has(second)).toBe(false);
    expect((await sections(s.assessmentId)).map((r) => [r.title, r.sortOrder])).toEqual([
      ["A. Pilihan ganda", 0],
      ["C", 1],
    ]);
    const rows = await database.db
      .select()
      .from(assessmentItems)
      .where(eq(assessmentItems.sectionId, s.first));
    expect(rows.map((r) => r.sortOrder).sort()).toEqual([0, 1, 2]);
  });

  it("moves the items of the first section to the next one, ahead of its own", async () => {
    const s = await seed();
    const second = await mk(s, "B");
    await addTo(s, s.first, [0, 1]);
    await addTo(s, second, [2]);
    await remove(USER_A, s.first);
    expect((await place(s)).get(second)).toEqual([0, 1, 2]);
    expect((await sections(s.assessmentId)).map((r) => [r.id, r.sortOrder])).toEqual([
      [second, 0],
    ]);
  });

  it("refuses to remove the last section", async () => {
    const s = await seed();
    await addTo(s, s.first, [0]);
    expect(await remove(USER_A, s.first)).toEqual({ ok: false, error: "lastSection" });
    expect(await sections(s.assessmentId)).toHaveLength(1);
    expect((await place(s)).get(s.first)).toEqual([0]);
  });

  it("is notFound for another teacher's section and refused once approved", async () => {
    const s = await seed();
    const second = await mk(s, "B");
    expect(await remove(USER_B, second)).toEqual({ ok: false, error: "notFound" });
    await lock(s);
    expect(await remove(USER_A, second)).toEqual({ ok: false, error: "approved" });
    expect(await sections(s.assessmentId)).toHaveLength(2);
  });
});
