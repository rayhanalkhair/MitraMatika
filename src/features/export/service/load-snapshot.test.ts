import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser } from "@/lib/db/client";
import { assessments, questionVersions } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { seedCurriculum } from "@/features/generation";
import {
  addItems,
  createAssessment,
  setShuffle,
  type AssessmentDb,
} from "@/features/assessments";
import {
  ASSESSMENT_INPUT,
  clearAll,
  seedBankedQuestions,
} from "@/features/assessments/test-support";
import { buildDocumentModel, keyRows } from "./document-model";
import { loadExportSnapshot } from "./load-snapshot";
import { renderHtml } from "./render-html";

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
    const result = await createAssessment(tx, {
      ownerId: USER_A,
      input: ASSESSMENT_INPUT,
    });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  });
  await asUser(USER_A, (tx) =>
    addItems(tx, {
      ownerId: USER_A,
      assessmentId: created.id,
      sectionId: created.sectionId,
      questionIds,
    }),
  );
  return { assessmentId: created.id };
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

describe("loadExportSnapshot", () => {
  it(
    "reads the pinned versions' content and builds a paper whose key matches it (shuffle on)",
    async () => {
      const { assessmentId } = await seed();
      await asUser(USER_A, (tx) =>
        setShuffle(tx, { ownerId: USER_A, assessmentId, mode: "on" }),
      );
      const loaded = await asUser(USER_A, (tx) =>
        loadExportSnapshot(tx, { ownerId: USER_A, assessmentId }),
      );
      if (!loaded.ok) throw new Error(loaded.error);
      const snapshot = loaded.data;
      expect(snapshot.shuffleSeed).not.toBeNull();
      expect(snapshot.versions.size).toBe(4);

      const doc = buildDocumentModel(snapshot, null);
      const paper = doc.sections.flatMap((s) => s.items);
      expect(paper.map((i) => i.number)).toEqual([1, 2, 3, 4]);
      for (const item of paper) {
        const row = (
          await database.db
            .select()
            .from(questionVersions)
            .where(
              eq(
                questionVersions.id,
                snapshot.sections
                  .flatMap((s) => s.items)
                  .find((i) => i.itemId === item.itemId)?.versionId ?? "",
              ),
            )
        )[0];
        expect(item.stemMd).toBe(row.stemMd);
        expect(item.options).toHaveLength(4);
        expect(item.answerMd).toMatch(/^[A-D]$/);
        expect(item.steps.length).toBeGreaterThan(0);
      }
      expect(keyRows(doc).map((r) => r.answer)).toEqual(paper.map((i) => i.answerMd));
      expect(renderHtml(doc, "key", doc.page)).toContain("Kunci Jawaban");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "is null for another teacher's, an unknown and a malformed assessment",
    async () => {
      const { assessmentId } = await seed();
      const other = await asUser(USER_B, (tx) =>
        loadExportSnapshot(tx, { ownerId: USER_B, assessmentId }),
      );
      expect(other).toEqual({ ok: false, error: "notFound" });
      const unknown = await asUser(USER_A, (tx) =>
        loadExportSnapshot(tx, {
          ownerId: USER_A,
          assessmentId: "00000000-0000-4000-8000-000000000000",
        }),
      );
      expect(unknown).toEqual({ ok: false, error: "notFound" });
      const bad = await asUser(USER_A, (tx) =>
        loadExportSnapshot(tx, { ownerId: USER_A, assessmentId: "nope" }),
      );
      expect(bad).toEqual({ ok: false, error: "notFound" });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "is null for a trashed assessment",
    async () => {
      const { assessmentId } = await seed();
      await database.db
        .update(assessments)
        .set({ deletedAt: new Date() })
        .where(eq(assessments.id, assessmentId));
      const result = await asUser(USER_A, (tx) =>
        loadExportSnapshot(tx, { ownerId: USER_A, assessmentId }),
      );
      expect(result).toEqual({ ok: false, error: "notFound" });
    },
    DB_TEST_TIMEOUT,
  );
});
