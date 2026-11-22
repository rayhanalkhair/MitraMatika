import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  aiCalls,
  cpElements,
  curriculumVersions,
  generationRequests,
  generationRuns,
  jobs,
  learningObjectives,
  questions,
  materialPages,
  questionSources,
  questionVersions,
  topics,
  verificationRuns,
} from "@/lib/db/schema";
import { seedMaterial, seedPages } from "@/features/materials/fixtures/library";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import {
  insertVerificationRun,
  multipleChoiceQuestionSchema,
  persistDrafts,
  questionJson,
  seedCurriculum,
  seedGenerationRequest,
  type AnyDb,
} from "@/features/generation";
import { getBankQuestion } from "@/features/bank";
import type { EditInput } from "../schema/edit-input";
import { editQuestion, getEditableQuestion } from "./edit-question";

let database: TestDatabase;
const NOW = new Date("2026-11-08T10:00:00.000Z");
const LATER = new Date("2026-11-08T11:00:00.000Z");
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

// The seeded question: "Hitung $1 + 1$.", options 1/2/3/4, key B, claim 1+1 = 2.
const BASE: EditInput = {
  stemMd: "Hitung $1 + 1$.",
  options: [
    { label: "A", textMd: "1" },
    { label: "B", textMd: "2" },
    { label: "C", textMd: "3" },
    { label: "D", textMd: "4" },
  ],
  correctLabel: "B",
  answerDisplayMd: "2",
  explanationMd: "Jumlahkan kedua bilangan.",
  steps: ["Tulis soalnya.", "Jumlahkan kedua bilangan."],
};

async function seed(ownerId = USER_A) {
  const c = await seedCurriculum(database.db);
  const { requestId, jobId } = await seedGenerationRequest(database.db, {
    ownerId,
    quantity: 1,
    ...c,
  });
  const saved = await database.db.transaction(async (tx) =>
    persistDrafts(tx as unknown as AnyDb, {
      ownerId,
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
      questions: [multipleChoiceQuestionSchema.parse(questionJson(1))],
      now: NOW,
    }),
  );
  // Edits wait for the pipeline; most tests start from a finished job.
  await database.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.id, jobId));
  return { questionId: saved.questionIds[0], jobId };
}

const loadQuestion = async (questionId: string) =>
  (await database.db.select().from(questions).where(eq(questions.id, questionId)))[0];
const versionsOf = (questionId: string) =>
  database.db
    .select()
    .from(questionVersions)
    .where(eq(questionVersions.questionId, questionId))
    .orderBy(asc(questionVersions.versionNo));

async function edit(
  questionId: string,
  content: Partial<EditInput> = {},
  overrides: Partial<Parameters<typeof editQuestion>[1]> = {},
) {
  const q = await loadQuestion(questionId);
  return editQuestion(db(), {
    ownerId: USER_A,
    questionId,
    expectedRowVersion: q.rowVersion,
    content: { ...BASE, ...content },
    now: LATER,
    ...overrides,
  });
}

// Approves (and optionally banks) the seeded question as the review would.
async function approve(questionId: string, banked: boolean) {
  const q = await loadQuestion(questionId);
  await database.db
    .update(questions)
    .set({
      status: "approved",
      approvedVersionId: q.currentVersionId,
      approvedAt: NOW,
      approvalOverride: { note: "x", versionId: q.currentVersionId, at: "t" },
      bankedAt: banked ? NOW : null,
    })
    .where(eq(questions.id, questionId));
  await insertVerificationRun(db(), {
    ownerId: USER_A,
    versionId: q.currentVersionId!,
    verifierVersion: "p1-12.1",
    status: "terverifikasi",
    checks: [],
    crossCheck: null,
    now: NOW,
  });
}

const DUPLICATE_OPTION = BASE.options.map((o) =>
  o.label === "C" ? { ...o, textMd: "2" } : o,
);

describe("editQuestion", () => {
  it("creates version n+1 with author teacher and kind edited, and leaves the old version unchanged", async () => {
    const { questionId } = await seed();
    const before = await loadQuestion(questionId);
    const [v1Before] = await versionsOf(questionId);

    const result = await edit(questionId, { explanationMd: "Tambahkan kedua bilangan." });

    expect(result.ok).toBe(true);
    const versions = await versionsOf(questionId);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toEqual(v1Before);
    expect(versions[1]).toMatchObject({
      versionNo: 2,
      author: "teacher",
      changeKind: "edited",
      explanationMd: "Tambahkan kedua bilangan.",
      stemMd: BASE.stemMd,
      createdAt: LATER,
    });
    expect(result).toEqual({
      ok: true,
      data: { versionId: versions[1].id, status: "terverifikasi" },
    });
    const after = await loadQuestion(questionId);
    expect(after).toMatchObject({
      currentVersionId: versions[1].id,
      rowVersion: before.rowVersion + 1,
      updatedAt: LATER,
    });
    expect(after.searchText).toContain("tambahkan kedua bilangan");
    // The curriculum source follows the new version, so the trace keeps its anchor.
    const sources = await database.db
      .select()
      .from(questionSources)
      .where(eq(questionSources.questionVersionId, versions[1].id));
    expect(sources).toHaveLength(1);
  });

  it("carries the material citation, with its material and page, to the new version", async () => {
    const { questionId } = await seed();
    const materialId = await seedMaterial(database, { ownerId: USER_A, pageCount: 1 });
    await seedPages(database, { ownerId: USER_A, materialId, texts: ["Halaman satu"] });
    const [page] = await database.db
      .select({ id: materialPages.id })
      .from(materialPages)
      .where(eq(materialPages.materialId, materialId));
    const q = await loadQuestion(questionId);
    await database.db.insert(questionSources).values({
      ownerId: USER_A,
      questionVersionId: q.currentVersionId!,
      kind: "material",
      materialId,
      materialPageId: page.id,
      anchorLabel: "hal. 1",
      excerpt: "Halaman satu",
    });

    expect((await edit(questionId, { explanationMd: "Baru." })).ok).toBe(true);
    const after = await loadQuestion(questionId);
    const copied = await database.db
      .select()
      .from(questionSources)
      .where(
        and(
          eq(questionSources.questionVersionId, after.currentVersionId!),
          eq(questionSources.kind, "material"),
        ),
      );
    expect(copied).toEqual([
      expect.objectContaining({
        materialId,
        materialPageId: page.id,
        anchorLabel: "hal. 1",
        excerpt: "Halaman satu",
      }),
    ]);
  });

  it("records a verification run for the new version", async () => {
    const { questionId } = await seed();
    const result = await edit(questionId, { explanationMd: "Lain." });
    if (!result.ok) throw new Error("expected ok");
    const runs = await database.db
      .select()
      .from(verificationRuns)
      .where(eq(verificationRuns.questionVersionId, result.data.versionId));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("terverifikasi");
  });

  it("keeps the checks when only the explanation changes, and drops them when the question itself changes", async () => {
    const { questionId } = await seed();
    const kept = await edit(questionId, { explanationMd: "Lain." });
    expect(kept).toMatchObject({ ok: true, data: { status: "terverifikasi" } });

    const changed = await edit(questionId, {
      stemMd: "Hitung $2 + 2$.",
      options: [
        { label: "A", textMd: "3" },
        { label: "B", textMd: "4" },
        { label: "C", textMd: "5" },
        { label: "D", textMd: "6" },
      ],
      answerDisplayMd: "4",
    });
    // The old claim described 1 + 1: it says nothing about the new question.
    expect(changed).toMatchObject({
      ok: true,
      data: { status: "belum_dapat_diverifikasi" },
    });
    const versions = await versionsOf(questionId);
    expect(versions[2].verificationClaims).toEqual([]);
    expect(versions[2].answer).toMatchObject({ display_md: "4", machine: "4" });
  });

  it("refuses a stale row version and writes nothing", async () => {
    const { questionId } = await seed();
    const q = await loadQuestion(questionId);
    const result = await edit(
      questionId,
      { explanationMd: "Lain." },
      { expectedRowVersion: q.rowVersion + 5 },
    );
    expect(result).toEqual({ ok: false, error: { code: "stale" } });
    expect(await versionsOf(questionId)).toHaveLength(1);
    expect(await loadQuestion(questionId)).toEqual(q);
  });

  it("returns invalid with the field path for LaTeX that does not parse, and writes nothing", async () => {
    const { questionId } = await seed();
    const result = await edit(questionId, {
      stemMd: "Hitung $\\frac{1$.",
      options: BASE.options.map((o) =>
        o.label === "C" ? { ...o, textMd: "$\\frac{$" } : o,
      ),
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid", fields: ["stemMd", "options.2.textMd"] },
    });
    expect(await versionsOf(questionId)).toHaveLength(1);
  });

  it("clears the approval when an approved question is edited into a mismatch", async () => {
    const { questionId } = await seed();
    await approve(questionId, false);
    // Two options of the same value: a proven structural problem.
    const result = await edit(questionId, { options: DUPLICATE_OPTION });
    expect(result).toMatchObject({ ok: true, data: { status: "ketidaksesuaian" } });
    expect(await loadQuestion(questionId)).toMatchObject({
      status: "draft",
      approvedVersionId: null,
      approvedAt: null,
      approvalOverride: null,
    });
  });

  it("never carries an approval over to a new version of an unbanked question", async () => {
    const { questionId } = await seed();
    await approve(questionId, false);
    const result = await edit(questionId, { explanationMd: "Lain." });
    expect(result).toMatchObject({ ok: true, data: { status: "terverifikasi" } });
    expect(await loadQuestion(questionId)).toMatchObject({
      status: "draft",
      approvedVersionId: null,
      approvedAt: null,
      approvalOverride: null,
    });
  });

  it("keeps a banked question banked and shows the new version in the bank", async () => {
    const { questionId } = await seed();
    await approve(questionId, true);
    const result = await edit(questionId, { stemMd: "Berapakah $1 + 1$?" });
    if (!result.ok) throw new Error("expected ok");

    const after = await loadQuestion(questionId);
    expect(after).toMatchObject({
      status: "approved",
      approvedVersionId: result.data.versionId,
      currentVersionId: result.data.versionId,
      bankedAt: NOW,
      approvalOverride: null,
    });
    const detail = await getBankQuestion(db(), { ownerId: USER_A, questionId });
    expect(detail?.question.stemMd).toBe("Berapakah $1 + 1$?");
    expect(detail?.question.versionNo).toBe(2);
  });

  it("takes a banked question out of the bank, back to review, when the edit is a mismatch", async () => {
    const { questionId } = await seed();
    await approve(questionId, true);
    const result = await edit(questionId, { options: DUPLICATE_OPTION });
    expect(result).toMatchObject({ ok: true, data: { status: "ketidaksesuaian" } });
    expect(await loadQuestion(questionId)).toMatchObject({
      status: "draft",
      approvedVersionId: null,
      bankedAt: null,
    });
    expect(await getBankQuestion(db(), { ownerId: USER_A, questionId })).toBeNull();
  });

  it("returns notFound for another teacher's question and for an unknown id", async () => {
    const { questionId } = await seed(USER_B);
    const q = await loadQuestion(questionId);
    const foreign = await editQuestion(db(), {
      ownerId: USER_A,
      questionId,
      expectedRowVersion: q.rowVersion,
      content: BASE,
      now: LATER,
    });
    expect(foreign).toEqual({ ok: false, error: { code: "notFound" } });
    expect(await versionsOf(questionId)).toHaveLength(1);

    const unknown = await editQuestion(db(), {
      ownerId: USER_A,
      questionId: "99999999-9999-4999-8999-999999999999",
      expectedRowVersion: 1,
      content: BASE,
      now: LATER,
    });
    expect(unknown).toEqual({ ok: false, error: { code: "notFound" } });
  });

  it("returns trashed for a question in the trash", async () => {
    const { questionId } = await seed();
    await database.db
      .update(questions)
      .set({ deletedAt: NOW, purgeAfter: LATER })
      .where(eq(questions.id, questionId));
    const result = await edit(questionId, { explanationMd: "Lain." });
    expect(result).toEqual({ ok: false, error: { code: "trashed" } });
    expect(await versionsOf(questionId)).toHaveLength(1);
  });
});

describe("editQuestion checks and guards", () => {
  it("keeps a cross-check mismatch when only the explanation changes", async () => {
    const { questionId } = await seed();
    const q = await loadQuestion(questionId);
    await database.db
      .update(questions)
      .set({
        status: "approved",
        approvedVersionId: q.currentVersionId,
        approvedAt: NOW,
        bankedAt: null,
      })
      .where(eq(questions.id, questionId));
    // Deterministic claims pass, the independent solver chose another option.
    await insertVerificationRun(db(), {
      ownerId: USER_A,
      versionId: q.currentVersionId!,
      verifierVersion: "p1-12.1",
      status: "ketidaksesuaian",
      checks: [],
      crossCheck: { provider: "groq", model: "m", verdict: "disagree" },
      now: NOW,
    });

    const result = await edit(questionId, { explanationMd: "Cukup tambahkan." });

    expect(result).toMatchObject({ ok: true, data: { status: "ketidaksesuaian" } });
    expect(await loadQuestion(questionId)).toMatchObject({
      status: "draft",
      approvedVersionId: null,
    });
  });

  it("carries an agreeing cross-check as dicek_silang when no claim covers the math", async () => {
    const { questionId } = await seed();
    const q = await loadQuestion(questionId);
    await insertVerificationRun(db(), {
      ownerId: USER_A,
      versionId: q.currentVersionId!,
      verifierVersion: "p1-12.1",
      status: "terverifikasi",
      checks: [],
      crossCheck: { provider: "groq", model: "m", verdict: "agree" },
      now: NOW,
    });
    const changed = await edit(questionId, {
      stemMd: "Hitung $2 + 2$.",
      options: [
        { label: "A", textMd: "3" },
        { label: "B", textMd: "4" },
        { label: "C", textMd: "5" },
        { label: "D", textMd: "6" },
      ],
      answerDisplayMd: "4",
    });
    // The math changed: the old solver verdict says nothing about the new question.
    expect(changed).toMatchObject({
      ok: true,
      data: { status: "belum_dapat_diverifikasi" },
    });
  });

  it("refuses an edit while the generation job of the question is still running", async () => {
    const { questionId, jobId } = await seed();
    await database.db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId));
    const result = await edit(questionId, { explanationMd: "Lain." });
    expect(result).toEqual({ ok: false, error: { code: "notReady" } });
    expect(await versionsOf(questionId)).toHaveLength(1);
  });

  it("refuses an edit while a regeneration of the question is pending", async () => {
    const { questionId } = await seed();
    await database.db.insert(jobs).values({
      ownerId: USER_A,
      type: "regenerate_question",
      payload: { questionId, hint: null },
      status: "deferred",
    });
    const result = await edit(questionId, { explanationMd: "Lain." });
    expect(result).toEqual({ ok: false, error: { code: "regenerating" } });
    expect(await versionsOf(questionId)).toHaveLength(1);
  });

  it("drops the answer rules when the math changed and keeps them when it did not", async () => {
    const { questionId } = await seed();
    const [v1] = await versionsOf(questionId);
    // Versions are immutable: a version that carries rules is inserted, not updated.
    const [withRules] = await database.db
      .insert(questionVersions)
      .values({ ...v1, id: undefined, versionNo: 2, answerRules: { unit: "cm" } })
      .returning();
    await database.db
      .update(questions)
      .set({ currentVersionId: withRules.id })
      .where(eq(questions.id, questionId));

    await edit(questionId, { explanationMd: "Lain." });
    await edit(questionId, {
      stemMd: "Hitung $5 + 5$.",
      options: [
        { label: "A", textMd: "9" },
        { label: "B", textMd: "10" },
        { label: "C", textMd: "11" },
        { label: "D", textMd: "12" },
      ],
      answerDisplayMd: "10",
    });
    const versions = await versionsOf(questionId);
    expect(versions[2].answerRules).toEqual({ unit: "cm" });
    expect(versions[3].answerRules).toBeNull();
  });
});

describe("getEditableQuestion", () => {
  it("returns the current version's content and row version, owner only, never a trashed one", async () => {
    const { questionId } = await seed();
    await edit(questionId, { explanationMd: "Lain." });
    const q = await loadQuestion(questionId);

    const found = await getEditableQuestion(db(), { ownerId: USER_A, questionId });
    expect(found).toMatchObject({
      questionId,
      rowVersion: q.rowVersion,
      banked: false,
      content: { ...BASE, explanationMd: "Lain." },
    });
    expect(await getEditableQuestion(db(), { ownerId: USER_B, questionId })).toBeNull();

    await database.db
      .update(questions)
      .set({ deletedAt: NOW, purgeAfter: LATER })
      .where(eq(questions.id, questionId));
    expect(await getEditableQuestion(db(), { ownerId: USER_A, questionId })).toBeNull();
  });
});
