import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  aiCalls,
  cpElements,
  curriculumVersions,
  generationRequests,
  generationRuns,
  jobs,
  learningObjectives,
  questions,
  questionVersions,
  topics,
  verificationRuns,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { persistDrafts, type AnyDb } from "@/features/generation";
import { getRequestReview } from "./review";
import { multipleChoiceQuestionSchema } from "@/features/generation";
import {
  questionJson,
  seedCurriculum,
  seedGenerationRequest,
} from "@/features/generation";
import {
  insertRegenerationMarker,
  insertVerificationRun,
  persistRegeneratedVersion,
} from "@/features/generation";

let database: TestDatabase;
const NOW = new Date("2026-11-08T10:00:00.000Z");
const db = () => database.db as unknown as AnyDb;

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  const d = database.db;
  await d.delete(verificationRuns);
  await d.delete(questions);
  await d.delete(generationRuns);
  await d.delete(aiCalls);
  await d.delete(generationRequests);
  await d.delete(jobs);
  await d.delete(learningObjectives);
  await d.delete(topics);
  await d.delete(cpElements);
  await d.delete(curriculumVersions);
});

async function seed(count: number, quantity = count) {
  const c = await seedCurriculum(database.db);
  const { requestId } = await seedGenerationRequest(database.db, {
    ownerId: USER_A,
    quantity,
    ...c,
  });
  const saved = await database.db.transaction(async (tx) =>
    persistDrafts(tx as unknown as AnyDb, {
      ownerId: USER_A,
      requestId,
      topicId: c.topicId,
      sourceRef: c.sourceRef,
      grade: 8,
      difficulty: "sedang",
      run: {
        provider: "groq",
        model: "openai/gpt-oss-120b",
        promptVersion: "generate-mc.id@1",
        curriculumVersionId: c.versionId,
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 5,
      },
      questions: Array.from({ length: count }, (_, i) =>
        multipleChoiceQuestionSchema.parse(questionJson(i + 1)),
      ),
      now: NOW,
    }),
  );
  return { c, requestId, questionIds: saved.questionIds };
}

const versionIdOf = async (questionId: string) => {
  const [q] = await database.db
    .select()
    .from(questions)
    .where(eq(questions.id, questionId));
  return q.currentVersionId!;
};

describe("getRequestReview", () => {
  it("returns content, status and curriculum for a generated request", async () => {
    const { requestId, questionIds } = await seed(2, 5);
    await insertVerificationRun(db(), {
      ownerId: USER_A,
      versionId: await versionIdOf(questionIds[0]),
      verifierVersion: "p1-12.1",
      status: "terverifikasi",
      checks: [{ type: "numeric_eval", status: "pass", detail: "1+1 = 2" }],
      crossCheck: { provider: "groq", model: "openai/gpt-oss-20b", verdict: "agree" },
      now: NOW,
    });

    const review = await getRequestReview(db(), { ownerId: USER_A, requestId });

    expect(review).toMatchObject({
      requested: 5,
      curriculum: {
        versionCode: "v1",
        topicTitle: "SPLDV",
        elementName: "Aljabar",
        objectives: [{ code: "TP-3", text: "Tiga" }],
      },
    });
    expect(review!.questions).toHaveLength(2);
    const checked = review!.questions.find((q) => q.verification.checked)!;
    expect(checked).toMatchObject({
      difficulty: "sedang",
      correctLabel: "B",
      versionNo: 1,
      options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }],
      verification: {
        status: "terverifikasi",
        checked: true,
        crossCheck: "agree",
        checks: [{ type: "numeric_eval", status: "pass", detail: "1+1 = 2" }],
        regenerated: false,
      },
    });
    expect(checked.stemMd).toMatch(/^Hitung/);
    expect(checked.answerDisplayMd).not.toBe("");
    expect(checked.steps.length).toBeGreaterThanOrEqual(2);
    const unchecked = review!.questions.find((q) => !q.verification.checked)!;
    expect(unchecked.verification.status).toBe("belum_dapat_diverifikasi");
    expect(unchecked.verification.crossCheck).toBeNull();
  });

  it("reports a regenerated question and a failed regeneration", async () => {
    const { c, requestId, questionIds } = await seed(1);
    const v1 = await versionIdOf(questionIds[0]);
    await insertVerificationRun(db(), {
      ownerId: USER_A,
      versionId: v1,
      verifierVersion: "p1-12.1",
      status: "ketidaksesuaian",
      checks: [{ type: "numeric_eval", status: "fail", detail: "salah" }],
      crossCheck: { provider: "groq", model: "m", verdict: "agree" },
      now: NOW,
    });
    await database.db.transaction(async (tx) =>
      persistRegeneratedVersion(tx as unknown as AnyDb, {
        difficulty: "sedang",
        ownerId: USER_A,
        requestId,
        questionId: questionIds[0],
        topicId: c.topicId,
        sourceRef: c.sourceRef,
        run: {
          provider: "groq",
          model: "m",
          promptVersion: "generate-mc.id@1",
          curriculumVersionId: c.versionId,
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 1,
        },
        question: multipleChoiceQuestionSchema.parse(questionJson(9)),
        now: NOW,
      }),
    );
    const [q] = (await getRequestReview(db(), { ownerId: USER_A, requestId }))!.questions;
    expect(q).toMatchObject({
      versionNo: 2,
      verification: { regenerated: true, checked: false },
    });
  });

  it("reports a failed regeneration on the current version", async () => {
    const { requestId, questionIds } = await seed(1);
    const v1 = await versionIdOf(questionIds[0]);
    await insertVerificationRun(db(), {
      ownerId: USER_A,
      versionId: v1,
      verifierVersion: "p1-12.1",
      status: "ketidaksesuaian",
      checks: [],
      crossCheck: { provider: "groq", model: "m", verdict: "agree" },
      now: NOW,
    });
    await insertRegenerationMarker(db(), {
      ownerId: USER_A,
      versionId: v1,
      now: new Date(NOW.getTime() + 1000),
    });
    const [q] = (await getRequestReview(db(), { ownerId: USER_A, requestId }))!.questions;
    expect(q.verification).toMatchObject({
      status: "ketidaksesuaian",
      checked: true,
      regenerationFailed: true,
      regenerated: false,
    });
  });

  it("exposes versionId, rowVersion, decision and override flag", async () => {
    const { requestId, questionIds } = await seed(3);
    const [draftId, approvedId, archivedId] = questionIds as [string, string, string];

    const first = await getRequestReview(db(), { ownerId: USER_A, requestId });
    const draft = first!.questions.find((q) => q.questionId === draftId)!;
    expect(draft).toMatchObject({
      versionId: await versionIdOf(draftId),
      rowVersion: 1,
      decision: "draft",
      override: false,
    });

    await database.db
      .update(questions)
      .set({
        status: "approved",
        rowVersion: 2,
        approvedVersionId: await versionIdOf(approvedId),
        approvalOverride: { note: "Sudah saya periksa ulang dengan teliti." },
      })
      .where(eq(questions.id, approvedId));
    await database.db
      .update(questions)
      .set({ status: "archived" })
      .where(eq(questions.id, archivedId));

    const review = await getRequestReview(db(), { ownerId: USER_A, requestId });
    const approved = review!.questions.find((q) => q.questionId === approvedId)!;
    const rejected = review!.questions.find((q) => q.questionId === archivedId)!;
    expect(approved).toMatchObject({
      decision: "approved",
      rowVersion: 2,
      override: true,
    });
    expect(rejected).toMatchObject({ decision: "rejected", override: false });
  });

  it("never exposes the override note", async () => {
    const { requestId, questionIds } = await seed(1);
    const note = "CATATAN-RAHASIA-GURU-12345";
    await database.db
      .update(questions)
      .set({
        status: "approved",
        approvedVersionId: await versionIdOf(questionIds[0]),
        approvalOverride: { note },
      })
      .where(eq(questions.id, questionIds[0]));
    const review = await getRequestReview(db(), { ownerId: USER_A, requestId });
    expect(JSON.stringify(review)).not.toContain(note);
    expect(review!.questions[0].override).toBe(true);
  });

  it("reports banked only for an approved, current, saved question", async () => {
    const { requestId, questionIds } = await seed(3);
    const [bankedId, unbankedId, staleId] = questionIds as [string, string, string];
    const stamp = new Date("2026-11-08T10:00:00.000Z");
    for (const id of [bankedId, unbankedId, staleId]) {
      await database.db
        .update(questions)
        .set({ status: "approved", approvedVersionId: await versionIdOf(id) })
        .where(eq(questions.id, id));
    }
    await database.db
      .update(questions)
      .set({ bankedAt: stamp })
      .where(eq(questions.id, bankedId));
    // banked_at set, but the approval no longer matches the current version (the approval no longer points at it).
    await database.db
      .update(questions)
      .set({
        bankedAt: stamp,
        approvedVersionId: null,
      })
      .where(eq(questions.id, staleId));

    const review = await getRequestReview(db(), { ownerId: USER_A, requestId });
    const byId = (id: string) => review!.questions.find((q) => q.questionId === id)!;
    expect(byId(bankedId).banked).toBe(true);
    expect(byId(unbankedId).banked).toBe(false);
    expect(byId(staleId).banked).toBe(false);
    expect(byId(staleId).decision).toBe("draft");
  });

  it("reports banked false for a draft that has no banked_at", async () => {
    const { requestId } = await seed(1);
    const review = await getRequestReview(db(), { ownerId: USER_A, requestId });
    expect(review!.questions[0].banked).toBe(false);
  });

  it("returns null for another owner's request and for an unknown id", async () => {
    const { requestId } = await seed(1);
    expect(await getRequestReview(db(), { ownerId: USER_B, requestId })).toBeNull();
    expect(
      await getRequestReview(db(), {
        ownerId: USER_A,
        requestId: "99999999-9999-4999-8999-999999999999",
      }),
    ).toBeNull();
  });

  it("never exposes machine answers or model names", async () => {
    const { requestId, questionIds } = await seed(1);
    await insertVerificationRun(db(), {
      ownerId: USER_A,
      versionId: await versionIdOf(questionIds[0]),
      verifierVersion: "p1-12.1",
      status: "dicek_silang",
      checks: [{ type: "weird_internal_kind", status: "pass", detail: "ok" }],
      crossCheck: { provider: "groq", model: "openai/gpt-oss-20b", verdict: "agree" },
      now: NOW,
    });
    const review = await getRequestReview(db(), { ownerId: USER_A, requestId });
    const json = JSON.stringify(review);
    expect(json).not.toContain("gpt-oss");
    expect(json).not.toContain("groq");
    expect(json).not.toContain("machine");
    expect(json).not.toContain("weird_internal_kind");
    expect(review!.questions[0].verification.checks[0].type).toBe("other");
    expect(review!.questions[0].verification.status).toBe("dicek_silang");
  });

  const dupOptions = ["A", "A", "C", "D"].map((label) => ({ label, text_md: "x" }));
  it.each([
    ["not four options", []],
    ["duplicate labels", dupOptions],
  ])(
    "skips a question whose stored options are malformed (%s)",
    async (_name, options) => {
      const { c, requestId } = await seed(2);
      // A third question whose stored options are not four options. Inserts are allowed on the
      // immutable question_versions table; only updates are rejected. The version is inserted before
      // current_version_id is set (the foreign key is deferrable), as persistDrafts does.
      await database.db.transaction(async (tx) => {
        const [question] = await tx
          .insert(questions)
          .values({
            ownerId: USER_A,
            status: "draft",
            origin: "generated",
            grade: 8,
            type: "multiple_choice",
            difficulty: "sedang",
            topicId: c.topicId,
            generationRequestId: requestId,
            createdAt: NOW,
            updatedAt: NOW,
          })
          .returning({ id: questions.id });
        const [version] = await tx
          .insert(questionVersions)
          .values({
            difficulty: "sedang",
            ownerId: USER_A,
            questionId: question.id,
            versionNo: 1,
            author: "ai",
            changeKind: "generated",
            stemMd: "Rusak",
            options,
            answer: { display_md: "1", machine: "1", correctLabel: "B" },
            explanationMd: "x",
            steps: ["a", "b"],
            answerRules: null,
            verificationClaims: [],
            verificationStatus: "belum_dapat_diverifikasi",
            createdAt: NOW,
          })
          .returning({ id: questionVersions.id });
        await tx
          .update(questions)
          .set({ currentVersionId: version.id })
          .where(eq(questions.id, question.id));
      });

      const review = await getRequestReview(db(), { ownerId: USER_A, requestId });

      expect(review!.questions).toHaveLength(2);
      expect(review!.questions.every((q) => q.stemMd !== "Rusak")).toBe(true);
    },
  );
});
