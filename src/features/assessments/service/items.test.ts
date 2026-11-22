import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser } from "@/lib/db/client";
import {
  assessmentItems,
  assessments,
  assessmentSections,
  questions,
  questionVersions,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { seedCurriculum } from "@/features/generation";
import { editQuestion } from "@/features/review";
import { ASSESSMENT_INPUT, clearAll, seedBankedQuestions } from "../test-support";
import { createAssessment, getAssessmentEditor, type AssessmentDb } from "./assessments";
import {
  addItems,
  MAX_ADD_PER_CALL,
  MAX_ITEMS,
  moveItem,
  removeItem,
  updateItemToLatest,
  type ItemFailure,
} from "./items";
import { addSection } from "./sections";

let database: TestDatabase;
const db = () => database.db as unknown as AssessmentDb;
const NOW = new Date("2026-11-10T10:00:00.000Z");

const asUser = <T>(userId: string, fn: (tx: AssessmentDb) => Promise<T>) =>
  runAsUser(db(), userId, (tx) => fn(tx as unknown as AssessmentDb));

type Seed = Awaited<ReturnType<typeof seed>>;

// Teacher A: four banked questions (a), one assessment with two sections. Teacher B: one (b).
async function seed() {
  const curriculum = await seedCurriculum(database.db);
  const a = await seedBankedQuestions(database, {
    ownerId: USER_A,
    count: 4,
    curriculum,
  });
  const b = await seedBankedQuestions(database, {
    ownerId: USER_B,
    count: 1,
    curriculum,
  });
  const created = await asUser(USER_A, async (tx) => {
    const result = await createAssessment(tx, {
      ownerId: USER_A,
      input: ASSESSMENT_INPUT,
    });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  });
  const second = await asUser(USER_A, async (tx) => {
    const result = await addSection(tx, {
      ownerId: USER_A,
      assessmentId: created.id,
      title: "B. Uraian",
    });
    if (!result.ok) throw new Error(result.error);
    return result.data.id;
  });
  return { a, b, curriculum, assessmentId: created.id, first: created.sectionId, second };
}

const items = (assessmentId: string) =>
  database.db
    .select()
    .from(assessmentItems)
    .where(eq(assessmentItems.assessmentId, assessmentId))
    .orderBy(asc(assessmentItems.sectionId), asc(assessmentItems.sortOrder));

// The question indexes (into s.a) in each section, in order.
const layout = async (s: Seed) => {
  const rows = await items(s.assessmentId);
  const place = (sectionId: string) =>
    rows
      .filter((row) => row.sectionId === sectionId)
      .sort((x, y) => x.sortOrder - y.sortOrder)
      .map((row) => s.a.indexOf(row.questionId));
  return { first: place(s.first), second: place(s.second) };
};

async function add(s: Seed, sectionId: string, indexes: number[]) {
  const result = await asUser(USER_A, (tx) =>
    addItems(tx, {
      ownerId: USER_A,
      assessmentId: s.assessmentId,
      sectionId,
      questionIds: indexes.map((i) => s.a[i]),
    }),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
}

const itemOf = async (s: Seed, index: number) => {
  const [row] = await database.db
    .select()
    .from(assessmentItems)
    .where(
      and(
        eq(assessmentItems.assessmentId, s.assessmentId),
        eq(assessmentItems.questionId, s.a[index]),
      ),
    );
  return row;
};

const lock = (s: Seed) =>
  database.db
    .update(assessments)
    .set({ status: "approved", approvedAt: NOW, approvedSnapshotHash: "h" })
    .where(eq(assessments.id, s.assessmentId));

async function foreignAssessment(): Promise<string> {
  const [row] = await database.db
    .insert(assessments)
    .values({ ownerId: USER_B, title: "B", grade: 8 })
    .returning({ id: assessments.id });
  return row.id;
}

async function foreignSection(): Promise<string> {
  const [row] = await database.db
    .insert(assessmentSections)
    .values({
      ownerId: USER_B,
      assessmentId: await foreignAssessment(),
      title: "X",
      sortOrder: 0,
    })
    .returning({ id: assessmentSections.id });
  return row.id;
}

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await clearAll(database);
});

const fail = (error: ItemFailure) => ({ ok: false, error });
const refused = (code: "notBanked" | "pendingCheck", questionId: string) => ({
  ok: false,
  error: { code, questionId },
});

describe("addItems", () => {
  it("pins each question's current version at the end of the section, in the given order", async () => {
    const s = await seed();
    expect(await add(s, s.first, [2, 0])).toEqual({ added: 2, skipped: 0 });
    const rows = await items(s.assessmentId);
    expect(rows.map((row) => [row.questionId, row.sortOrder])).toEqual([
      [s.a[2], 0],
      [s.a[0], 1],
    ]);
    for (const row of rows) {
      const [question] = await database.db
        .select()
        .from(questions)
        .where(eq(questions.id, row.questionId));
      expect(row.questionVersionId).toBe(question.currentVersionId);
      expect(row.ownerId).toBe(USER_A);
      expect(row.points).toBe("0.00");
    }
    expect(await add(s, s.first, [3])).toEqual({ added: 1, skipped: 0 });
    expect((await layout(s)).first).toEqual([2, 0, 3]);
  });

  it("skips a question that is already in the assessment, in any section, and a repeated id", async () => {
    const s = await seed();
    await add(s, s.first, [0]);
    const again = await asUser(USER_A, (tx) =>
      addItems(tx, {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        sectionId: s.second,
        questionIds: [s.a[0], s.a[1], s.a[1]],
      }),
    );
    expect(again).toEqual({ ok: true, data: { added: 1, skipped: 2 } });
    expect(await layout(s)).toEqual({ first: [0], second: [1] });
  });

  it("refuses unbanked, trashed, draft, other teachers' and unknown questions, adding nothing", async () => {
    const s = await seed();
    const [unbanked, trashed, draft] = [s.a[1], s.a[2], s.a[3]];
    await database.db
      .update(questions)
      .set({ bankedAt: null })
      .where(eq(questions.id, unbanked));
    await database.db
      .update(questions)
      .set({ deletedAt: NOW })
      .where(eq(questions.id, trashed));
    await database.db
      .update(questions)
      .set({ status: "draft" })
      .where(eq(questions.id, draft));
    for (const bad of [unbanked, trashed, draft, s.b[0], crypto.randomUUID()]) {
      const result = await asUser(USER_A, (tx) =>
        addItems(tx, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          sectionId: s.first,
          questionIds: [s.a[0], bad],
        }),
      );
      expect(result).toEqual(refused("notBanked", bad));
    }
    expect(await items(s.assessmentId)).toHaveLength(0);
  });

  // A banked question whose regeneration waits for its check: current is a newer, unapproved version.
  async function startRegeneration(questionId: string) {
    const [version] = await database.db
      .select()
      .from(questionVersions)
      .where(eq(questionVersions.questionId, questionId));
    const [next] = await database.db
      .insert(questionVersions)
      .values({
        ...version,
        id: crypto.randomUUID(),
        versionNo: 2,
        author: "ai",
        changeKind: "regenerated",
      })
      .returning({ id: questionVersions.id });
    await database.db
      .update(questions)
      .set({ currentVersionId: next.id })
      .where(eq(questions.id, questionId));
  }

  it("refuses a question whose regeneration is pending with its own key, naming it", async () => {
    const s = await seed();
    await startRegeneration(s.a[1]);
    const result = await asUser(USER_A, (tx) =>
      addItems(tx, {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        sectionId: s.first,
        questionIds: [s.a[0], s.a[1]],
      }),
    );
    expect(result).toEqual(refused("pendingCheck", s.a[1]));
    expect(await items(s.assessmentId)).toHaveLength(0);
  });

  it("flags a pending item, refuses to update it with its own key, and the picker marks it", async () => {
    const s = await seed();
    await add(s, s.first, [0]);
    await startRegeneration(s.a[0]);
    const view = await asUser(USER_A, (tx) =>
      getAssessmentEditor(tx, { ownerId: USER_A, assessmentId: s.assessmentId }),
    );
    const flagged = view?.sections.flatMap((x) => x.items)[0];
    expect(flagged).toMatchObject({
      state: "pending",
      newerVersionAvailable: true,
      canUpdate: false,
    });
    const itemId = (await itemOf(s, 0)).id;
    expect(
      await asUser(USER_A, (tx) => updateItemToLatest(tx, { ownerId: USER_A, itemId })),
    ).toEqual(fail("pendingCheck"));
  });

  it("caps the ids of one call and the items of one assessment, with typed errors", async () => {
    const s = await seed();
    const many = Array.from({ length: MAX_ADD_PER_CALL + 1 }, () => s.a[0]);
    expect(
      await asUser(USER_A, (tx) =>
        addItems(tx, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          sectionId: s.first,
          questionIds: many,
        }),
      ),
    ).toEqual(fail("tooManyAtOnce"));
    // Fill the assessment to its cap straight in the table, then one more is refused.
    expect(MAX_ITEMS).toBe(200);
    const fillerIds = await seedBankedQuestions(database, {
      ownerId: USER_A,
      count: MAX_ITEMS,
      curriculum: s.curriculum,
    });
    const fillers = await database.db
      .select({ id: questions.id, versionId: questions.currentVersionId })
      .from(questions)
      .where(inArray(questions.id, fillerIds));
    await database.db.insert(assessmentItems).values(
      fillers.map((q, i) => ({
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        sectionId: s.first,
        questionId: q.id,
        questionVersionId: q.versionId ?? "",
        sortOrder: i,
      })),
    );
    expect(
      await asUser(USER_A, (tx) =>
        addItems(tx, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          sectionId: s.first,
          questionIds: [s.a[0]],
        }),
      ),
    ).toEqual(fail("tooManyItems"));
  });

  it("refuses a section of another assessment, another teacher or a malformed id; an empty list adds nothing", async () => {
    const s = await seed();
    const other = await asUser(USER_A, async (tx) => {
      const r = await createAssessment(tx, { ownerId: USER_A, input: ASSESSMENT_INPUT });
      if (!r.ok) throw new Error(r.error);
      return r.data;
    });
    for (const sectionId of [other.sectionId, await foreignSection(), "not-a-uuid"]) {
      const result = await asUser(USER_A, (tx) =>
        addItems(tx, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          sectionId,
          questionIds: [s.a[0]],
        }),
      );
      expect(result).toEqual(fail("sectionNotFound"));
    }
    expect(
      await asUser(USER_A, (tx) =>
        addItems(tx, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          sectionId: s.first,
          questionIds: [],
        }),
      ),
    ).toEqual({ ok: true, data: { added: 0, skipped: 0 } });
    expect(await items(s.assessmentId)).toHaveLength(0);
  });

  it("is notFound for another teacher's assessment and adds nothing", async () => {
    const s = await seed();
    const result = await asUser(USER_B, (tx) =>
      addItems(tx, {
        ownerId: USER_B,
        assessmentId: s.assessmentId,
        sectionId: s.first,
        questionIds: s.b,
      }),
    );
    expect(result).toEqual(fail("notFound"));
    expect(await items(s.assessmentId)).toHaveLength(0);
  });

  it("is refused once approved", async () => {
    const s = await seed();
    await lock(s);
    const result = await asUser(USER_A, (tx) =>
      addItems(tx, {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        sectionId: s.first,
        questionIds: [s.a[0]],
      }),
    );
    expect(result).toEqual(fail("approved"));
    expect(await items(s.assessmentId)).toHaveLength(0);
  });
});

describe("removeItem", () => {
  const remove = (ownerId: string, itemId: string) =>
    asUser(ownerId, (tx) => removeItem(tx, { ownerId, itemId }));

  it("removes the item and renumbers the section densely; the question can be added again", async () => {
    const s = await seed();
    await add(s, s.first, [0, 1, 2]);
    expect(await remove(USER_A, (await itemOf(s, 1)).id)).toEqual({
      ok: true,
      data: undefined,
    });
    const rows = await items(s.assessmentId);
    expect(rows.map((row) => [s.a.indexOf(row.questionId), row.sortOrder])).toEqual([
      [0, 0],
      [2, 1],
    ]);
    expect(await add(s, s.first, [1])).toEqual({ added: 1, skipped: 0 });
  });

  it("is notFound for a foreign or malformed item and refused once approved", async () => {
    const s = await seed();
    await add(s, s.first, [0]);
    const target = await itemOf(s, 0);
    expect(await remove(USER_B, target.id)).toEqual(fail("notFound"));
    expect(await remove(USER_A, "nope")).toEqual(fail("notFound"));
    await lock(s);
    expect(await remove(USER_A, target.id)).toEqual(fail("approved"));
    expect(await items(s.assessmentId)).toHaveLength(1);
  });
});

describe("moveItem", () => {
  // The item id is read before the transaction: PGlite has one connection, so a query outside the
  // transaction while it is open would wait for it forever.
  const move = async (
    s: Seed,
    index: number,
    toSectionId: string,
    toIndex: number,
    owner = USER_A,
  ) => {
    const itemId = (await itemOf(s, index)).id;
    return asUser(owner, (tx) =>
      moveItem(tx, { ownerId: owner, itemId, toSectionId, toIndex }),
    );
  };

  it("moves within a section, down and up, renumbering densely", async () => {
    const s = await seed();
    await add(s, s.first, [0, 1, 2, 3]);
    expect(await move(s, 0, s.first, 2)).toEqual({ ok: true, data: undefined });
    expect((await layout(s)).first).toEqual([1, 2, 0, 3]);
    await move(s, 3, s.first, 0);
    expect((await layout(s)).first).toEqual([3, 1, 2, 0]);
    expect((await items(s.assessmentId)).map((r) => r.sortOrder).sort()).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("clamps the index at the boundaries", async () => {
    const s = await seed();
    await add(s, s.first, [0, 1, 2]);
    await move(s, 1, s.first, -5);
    expect((await layout(s)).first).toEqual([1, 0, 2]);
    await move(s, 1, s.first, 99);
    expect((await layout(s)).first).toEqual([0, 2, 1]);
    // The first item to the first place changes nothing.
    await move(s, 0, s.first, 0);
    expect((await layout(s)).first).toEqual([0, 2, 1]);
  });

  it("moves to another section at an index, renumbering both sections", async () => {
    const s = await seed();
    await add(s, s.first, [0, 1, 2]);
    await add(s, s.second, [3]);
    await move(s, 1, s.second, 0);
    expect(await layout(s)).toEqual({ first: [0, 2], second: [1, 3] });
    await move(s, 0, s.second, 99);
    expect(await layout(s)).toEqual({ first: [2], second: [1, 3, 0] });
    const rows = await items(s.assessmentId);
    const orders = (sectionId: string) =>
      rows
        .filter((r) => r.sectionId === sectionId)
        .map((r) => r.sortOrder)
        .sort();
    expect(orders(s.first)).toEqual([0]);
    expect(orders(s.second)).toEqual([0, 1, 2]);
  });

  it("refuses a foreign or malformed section, a foreign item and an approved assessment", async () => {
    const s = await seed();
    await add(s, s.first, [0]);
    expect(await move(s, 0, await foreignSection(), 0)).toEqual(fail("sectionNotFound"));
    expect(await move(s, 0, "nope", 0)).toEqual(fail("sectionNotFound"));
    expect(await move(s, 0, s.second, 0, USER_B)).toEqual(fail("notFound"));
    await lock(s);
    expect(await move(s, 0, s.second, 0)).toEqual(fail("approved"));
    expect((await layout(s)).first).toEqual([0]);
  });
});

describe("updateItemToLatest and the editor read model", () => {
  const editBanked = async (questionId: string) => {
    const [question] = await database.db
      .select()
      .from(questions)
      .where(eq(questions.id, questionId));
    const [version] = await database.db
      .select()
      .from(questionVersions)
      .where(eq(questionVersions.id, question.currentVersionId ?? ""));
    const options = version.options as {
      label: "A" | "B" | "C" | "D";
      text_md: string;
    }[];
    const answer = version.answer as {
      display_md: string;
      correctLabel: "A" | "B" | "C" | "D";
    };
    const result = await editQuestion(database.db, {
      ownerId: USER_A,
      questionId,
      expectedRowVersion: question.rowVersion,
      content: {
        stemMd: `${version.stemMd} (revisi)`,
        options: options.map((o) => ({ label: o.label, textMd: o.text_md })),
        correctLabel: answer.correctLabel,
        answerDisplayMd: answer.display_md,
        explanationMd: version.explanationMd,
        steps: version.steps as string[],
      },
      now: NOW,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
  };

  const editorItems = async (s: Seed) => {
    const view = await asUser(USER_A, (tx) =>
      getAssessmentEditor(tx, { ownerId: USER_A, assessmentId: s.assessmentId }),
    );
    return view?.sections.flatMap((section) => section.items) ?? [];
  };

  const update = (ownerId: string, itemId: string) =>
    asUser(ownerId, (tx) => updateItemToLatest(tx, { ownerId, itemId }));

  it("resolves the pinned content and flags no newer version at first", async () => {
    const s = await seed();
    await add(s, s.first, [0]);
    const [item] = await editorItems(s);
    expect(item).toMatchObject({
      questionId: s.a[0],
      versionNo: 1,
      state: "ok",
      newerVersionAvailable: false,
      canUpdate: false,
      points: 0,
    });
    expect(item.correctLabel).toMatch(/^[A-D]$/);
    expect(item.stemMd).toContain("Hitung");
    expect(item.options).toHaveLength(4);
  });

  it("flags a newer version after the question is edited and keeps the pinned content until updated", async () => {
    const s = await seed();
    await add(s, s.first, [0, 1]);
    const before = (await editorItems(s)).find((i) => i.questionId === s.a[0]);
    await editBanked(s.a[0]);
    const after = await editorItems(s);
    const edited = after.find((i) => i.questionId === s.a[0]);
    expect(edited).toMatchObject({
      newerVersionAvailable: true,
      canUpdate: true,
      versionNo: 1,
      state: "ok",
    });
    expect(edited?.stemMd).toBe(before?.stemMd);
    expect(after.find((i) => i.questionId === s.a[1])?.newerVersionAvailable).toBe(false);

    const target = await itemOf(s, 0);
    expect(await update(USER_A, target.id)).toEqual({
      ok: true,
      data: { changed: true },
    });
    const updated = (await editorItems(s)).find((i) => i.questionId === s.a[0]);
    expect(updated).toMatchObject({ newerVersionAvailable: false, versionNo: 2 });
    expect(updated?.stemMd).toContain("(revisi)");
    expect((await layout(s)).first).toEqual([0, 1]);
    expect(await update(USER_A, target.id)).toEqual({
      ok: true,
      data: { changed: false },
    });
  });

  it("flags a trashed and an unbanked question and refuses to update them", async () => {
    const s = await seed();
    await add(s, s.first, [0, 1, 2]);
    await database.db
      .update(questions)
      .set({ deletedAt: NOW })
      .where(eq(questions.id, s.a[0]));
    await database.db
      .update(questions)
      .set({ bankedAt: null })
      .where(eq(questions.id, s.a[1]));
    const got = await editorItems(s);
    expect(got.find((i) => i.questionId === s.a[0])?.state).toBe("trashed");
    expect(got.find((i) => i.questionId === s.a[1])?.state).toBe("unbanked");
    expect(got.find((i) => i.questionId === s.a[2])?.state).toBe("ok");
    for (const index of [0, 1]) {
      expect(await update(USER_A, (await itemOf(s, index)).id)).toEqual(
        fail("notBanked"),
      );
    }
  });

  it("does not update another teacher's item, nor an approved assessment's", async () => {
    const s = await seed();
    await add(s, s.first, [0]);
    await editBanked(s.a[0]);
    const target = await itemOf(s, 0);
    expect(await update(USER_B, target.id)).toEqual(fail("notFound"));
    expect(await update(USER_A, "nope")).toEqual(fail("notFound"));
    await lock(s);
    expect(await update(USER_A, target.id)).toEqual(fail("approved"));
    expect((await itemOf(s, 0)).questionVersionId).toBe(target.questionVersionId);
  });
});
