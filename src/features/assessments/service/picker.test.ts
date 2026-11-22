import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bankQuerySchema } from "@/features/bank";
import { seedCurriculum } from "@/features/generation";
import { runAsUser } from "@/lib/db/client";
import { questions, questionVersions } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { ASSESSMENT_INPUT, clearAll, seedBankedQuestions } from "../test-support";
import { createAssessment, type AssessmentDb } from "./assessments";
import { addItems } from "./items";
import { listBankedSince, loadPicker } from "./picker";

let database: TestDatabase;
const db = () => database.db as unknown as AssessmentDb;
const asUser = <T>(userId: string, fn: (tx: AssessmentDb) => Promise<T>) =>
  runAsUser(db(), userId, (tx) => fn(tx as unknown as AssessmentDb));

const OLD = new Date("2026-11-01T00:00:00.000Z");
const NEW = new Date("2026-11-15T00:00:00.000Z");
const SINCE = new Date("2026-11-10T00:00:00.000Z");

async function seed() {
  const curriculum = await seedCurriculum(database.db);
  const old = await seedBankedQuestions(database, {
    ownerId: USER_A,
    count: 2,
    curriculum,
    bankedAt: OLD,
  });
  const fresh = await seedBankedQuestions(database, {
    ownerId: USER_A,
    count: 2,
    curriculum,
    bankedAt: NEW,
  });
  const foreign = await seedBankedQuestions(database, {
    ownerId: USER_B,
    count: 1,
    curriculum,
    bankedAt: NEW,
  });
  const created = await asUser(USER_A, async (tx) => {
    const r = await createAssessment(tx, { ownerId: USER_A, input: ASSESSMENT_INPUT });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  });
  return { old, fresh, foreign, ...created };
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

describe("loadPicker", () => {
  it("lists the owner's banked questions through the bank query and marks the ones already added", async () => {
    const s = await seed();
    await asUser(USER_A, (tx) =>
      addItems(tx, {
        ownerId: USER_A,
        assessmentId: s.id,
        sectionId: s.sectionId,
        questionIds: [s.old[0]],
      }),
    );
    const picker = await asUser(USER_A, (tx) =>
      loadPicker(tx, {
        ownerId: USER_A,
        assessmentId: s.id,
        query: bankQuerySchema.parse({}),
      }),
    );
    expect(picker?.list.total).toBe(4);
    expect(picker?.list.items.map((i) => i.questionId).sort()).toEqual(
      [...s.old, ...s.fresh].sort(),
    );
    expect(picker?.added).toEqual([s.old[0]]);
  });

  it("excludes trashed and unbanked questions and applies the bank filters", async () => {
    const s = await seed();
    await database.db
      .update(questions)
      .set({ deletedAt: NEW })
      .where(eq(questions.id, s.old[0]));
    await database.db
      .update(questions)
      .set({ bankedAt: null })
      .where(eq(questions.id, s.old[1]));
    const all = await asUser(USER_A, (tx) =>
      loadPicker(tx, {
        ownerId: USER_A,
        assessmentId: s.id,
        query: bankQuerySchema.parse({}),
      }),
    );
    expect(all?.list.items.map((i) => i.questionId).sort()).toEqual([...s.fresh].sort());
    const none = await asUser(USER_A, (tx) =>
      loadPicker(tx, {
        ownerId: USER_A,
        assessmentId: s.id,
        query: bankQuerySchema.parse({ difficulty: "sulit" }),
      }),
    );
    expect(none?.list.items).toEqual([]);
  });

  it("lists the questions whose regeneration is pending, which addItems would refuse", async () => {
    const s = await seed();
    const [version] = await database.db
      .select()
      .from(questionVersions)
      .where(eq(questionVersions.questionId, s.old[0]));
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
      .where(eq(questions.id, s.old[0]));
    const picker = await asUser(USER_A, (tx) =>
      loadPicker(tx, {
        ownerId: USER_A,
        assessmentId: s.id,
        query: bankQuerySchema.parse({}),
      }),
    );
    expect(picker?.list.items.map((i) => i.questionId)).toContain(s.old[0]);
    expect(picker?.pending).toEqual([s.old[0]]);
  });

  it("is null for another teacher's, a malformed and an unknown assessment", async () => {
    const s = await seed();
    const query = bankQuerySchema.parse({});
    expect(
      await asUser(USER_B, (tx) =>
        loadPicker(tx, { ownerId: USER_B, assessmentId: s.id, query }),
      ),
    ).toBeNull();
    expect(
      await asUser(USER_A, (tx) =>
        loadPicker(tx, { ownerId: USER_A, assessmentId: "nope", query }),
      ),
    ).toBeNull();
  });
});

describe("listBankedSince", () => {
  it("offers the questions banked since the time that are not in the assessment yet", async () => {
    const s = await seed();
    await asUser(USER_A, (tx) =>
      addItems(tx, {
        ownerId: USER_A,
        assessmentId: s.id,
        sectionId: s.sectionId,
        questionIds: [s.fresh[0]],
      }),
    );
    const offered = await asUser(USER_A, (tx) =>
      listBankedSince(tx, { ownerId: USER_A, assessmentId: s.id, since: SINCE }),
    );
    expect(offered.map((q) => q.questionId)).toEqual([s.fresh[1]]);
    expect(offered[0].stemExcerptMd).toContain("Hitung");
  });

  it("never offers another teacher's, a trashed or an unbanked question", async () => {
    const s = await seed();
    await database.db
      .update(questions)
      .set({ deletedAt: NEW })
      .where(eq(questions.id, s.fresh[0]));
    await database.db
      .update(questions)
      .set({ bankedAt: null })
      .where(eq(questions.id, s.fresh[1]));
    const offered = await asUser(USER_A, (tx) =>
      listBankedSince(tx, { ownerId: USER_A, assessmentId: s.id, since: SINCE }),
    );
    expect(offered).toEqual([]);
    const other = await asUser(USER_B, (tx) =>
      listBankedSince(tx, { ownerId: USER_B, assessmentId: s.id, since: SINCE }),
    );
    expect(other).toEqual([]);
  });
});
