import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
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
import { runAsUser } from "@/lib/db/client";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { decideQuestion, type DecisionAction } from "./decision";
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
const LATER = new Date("2026-11-08T11:00:00.000Z");
const db = () => database.db as unknown as AnyDb;
const VALID_NOTE = "Sudah saya periksa ulang dengan teliti.";

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

async function seed(count = 1) {
  const c = await seedCurriculum(database.db);
  const { requestId, jobId } = await seedGenerationRequest(database.db, {
    ownerId: USER_A,
    quantity: count,
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
  return { c, requestId, jobId, questionId: saved.questionIds[0] };
}

const loadQuestion = async (questionId: string) => {
  const [q] = await database.db
    .select()
    .from(questions)
    .where(eq(questions.id, questionId));
  return q;
};

async function versionIdOf(questionId: string) {
  return (await loadQuestion(questionId)).currentVersionId!;
}

async function addRun(
  versionId: string,
  status: string,
  at: Date = NOW,
  crossCheck: unknown = { provider: "groq", model: "m", verdict: "agree" },
) {
  await insertVerificationRun(db(), {
    ownerId: USER_A,
    versionId,
    verifierVersion: "p1-12.1",
    status,
    checks: [],
    crossCheck,
    now: at,
  } as Parameters<typeof insertVerificationRun>[1]);
}

async function setJob(jobId: string, status: string) {
  await database.db.update(jobs).set({ status }).where(eq(jobs.id, jobId));
}

async function decide(
  questionId: string,
  action: DecisionAction,
  overrides: Partial<Parameters<typeof decideQuestion>[1]> = {},
) {
  const q = await loadQuestion(questionId);
  return decideQuestion(db(), {
    ownerId: USER_A,
    questionId,
    versionId: q.currentVersionId!,
    rowVersion: q.rowVersion,
    action,
    now: LATER,
    ...overrides,
  });
}

describe("decideQuestion", () => {
  it("approves a checked draft and bumps the row version", async () => {
    const { questionId } = await seed();
    await addRun(await versionIdOf(questionId), "terverifikasi");
    const before = await loadQuestion(questionId);

    const result = await decide(questionId, "approve");

    expect(result).toEqual({
      ok: true,
      data: {
        decision: "approved",
        rowVersion: before.rowVersion + 1,
        override: false,
        versionNo: 1,
      },
    });
    const after = await loadQuestion(questionId);
    expect(after).toMatchObject({
      status: "approved",
      approvedVersionId: before.currentVersionId,
      rowVersion: before.rowVersion + 1,
      approvalOverride: null,
    });
    expect(after.approvedAt).toEqual(LATER);
    expect(after.updatedAt).toEqual(LATER);
  });

  it("rejects a draft by archiving it and clearing the approved columns", async () => {
    const { questionId } = await seed();
    const result = await decide(questionId, "reject");
    expect(result).toMatchObject({
      ok: true,
      data: { decision: "rejected", override: false },
    });
    expect(await loadQuestion(questionId)).toMatchObject({
      status: "archived",
      approvedVersionId: null,
      approvedAt: null,
      approvalOverride: null,
    });
  });

  it.each(["approved", "archived"] as const)("resets from %s to draft", async (from) => {
    const { questionId } = await seed();
    await addRun(await versionIdOf(questionId), "terverifikasi");
    if (from === "approved") {
      expect((await decide(questionId, "approve")).ok).toBe(true);
    } else {
      expect((await decide(questionId, "reject")).ok).toBe(true);
    }

    const result = await decide(questionId, "reset");

    expect(result).toMatchObject({
      ok: true,
      data: { decision: "draft", override: false },
    });
    expect(await loadQuestion(questionId)).toMatchObject({
      status: "draft",
      approvedVersionId: null,
      approvedAt: null,
      approvalOverride: null,
      rowVersion: 3,
    });
  });

  it("clears the override when an approved contradiction is rejected", async () => {
    const { questionId, jobId } = await seed();
    await setJob(jobId, "succeeded");
    await addRun(await versionIdOf(questionId), "ketidaksesuaian");
    const approved = await decide(questionId, "approve", { overrideNote: VALID_NOTE });
    expect(approved).toMatchObject({ ok: true, data: { override: true } });
    expect((await loadQuestion(questionId)).approvalOverride).not.toBeNull();

    const rejected = await decide(questionId, "reject");

    expect(rejected).toMatchObject({
      ok: true,
      data: { decision: "rejected", override: false },
    });
    expect((await loadQuestion(questionId)).approvalOverride).toBeNull();
  });

  it("requires an override note for a contradiction", async () => {
    const { questionId, jobId } = await seed();
    await setJob(jobId, "succeeded");
    await addRun(await versionIdOf(questionId), "ketidaksesuaian");
    expect(await decide(questionId, "approve")).toEqual({
      ok: false,
      error: "override_required",
    });
    const q = await loadQuestion(questionId);
    expect(q.status).toBe("draft");
    expect(q.rowVersion).toBe(1);
  });

  it.each([
    ["a 9-character note", "123456789"],
    ["a note of 9 characters plus padding spaces", "   123456789   "],
    ["a 501-character note", "x".repeat(501)],
  ])("rejects %s", async (_name, note) => {
    const { questionId, jobId } = await seed();
    await setJob(jobId, "succeeded");
    await addRun(await versionIdOf(questionId), "ketidaksesuaian");
    expect(await decide(questionId, "approve", { overrideNote: note })).toEqual({
      ok: false,
      error: "invalid_note",
    });
    expect((await loadQuestion(questionId)).status).toBe("draft");
  });

  it("approves a contradiction with a valid note and stores it trimmed", async () => {
    const { questionId, jobId } = await seed();
    await setJob(jobId, "succeeded");
    const versionId = await versionIdOf(questionId);
    await addRun(versionId, "ketidaksesuaian");

    const result = await decide(questionId, "approve", {
      overrideNote: `  ${VALID_NOTE}  `,
    });

    expect(result).toMatchObject({
      ok: true,
      data: { decision: "approved", override: true },
    });
    expect((await loadQuestion(questionId)).approvalOverride).toEqual({
      note: VALID_NOTE,
      versionId,
      at: LATER.toISOString(),
    });
  });

  it("accepts notes of exactly 10 and 500 characters", async () => {
    const { questionId, jobId } = await seed();
    await setJob(jobId, "succeeded");
    await addRun(await versionIdOf(questionId), "ketidaksesuaian");
    expect(
      await decide(questionId, "approve", { overrideNote: "1234567890" }),
    ).toMatchObject({ ok: true });
    expect(
      await decide(questionId, "approve", { overrideNote: "y".repeat(500) }),
    ).toMatchObject({ ok: true });
  });

  it("ignores a note on a non-contradiction and does not store it", async () => {
    const { questionId } = await seed();
    await addRun(await versionIdOf(questionId), "dicek_silang");
    const result = await decide(questionId, "approve", { overrideNote: VALID_NOTE });
    expect(result).toMatchObject({ ok: true, data: { override: false } });
    expect((await loadQuestion(questionId)).approvalOverride).toBeNull();
  });

  it("conflicts when the version moved on", async () => {
    const { questionId } = await seed();
    const v1 = await versionIdOf(questionId);
    await addRun(v1, "terverifikasi");
    const stale = await loadQuestion(questionId);
    await database.db.transaction(async (tx) => {
      const [v2] = await tx
        .insert(questionVersions)
        .values({
          difficulty: "sedang",
          ownerId: USER_A,
          questionId,
          versionNo: 2,
          author: "ai",
          changeKind: "regenerated",
          stemMd: "Baru",
          options: [],
          answer: {},
          explanationMd: "x",
          steps: [],
          answerRules: null,
          verificationClaims: [],
          verificationStatus: "belum_dapat_diverifikasi",
          createdAt: NOW,
        })
        .returning({ id: questionVersions.id });
      await tx
        .update(questions)
        .set({ currentVersionId: v2.id })
        .where(eq(questions.id, questionId));
    });

    const result = await decideQuestion(db(), {
      ownerId: USER_A,
      questionId,
      versionId: v1,
      rowVersion: stale.rowVersion,
      action: "approve",
      now: LATER,
    });

    expect(result).toEqual({ ok: false, error: "conflict" });
    expect((await loadQuestion(questionId)).status).toBe("draft");
  });

  it("conflicts when a regeneration lands between the read and the update", async () => {
    const { questionId } = await seed();
    const v1 = await versionIdOf(questionId);
    await addRun(v1, "terverifikasi");
    const before = await loadQuestion(questionId);

    // Deterministic race: after the third select (question, version, runs) resolves, a competing
    // regeneration moves current_version_id without bumping row_version, then the update runs.
    let selects = 0;
    const wrap = (target: object, onResolved?: () => Promise<void>): object =>
      new Proxy(target, {
        get(obj, key) {
          if (key === "then" && onResolved) {
            const then = (obj as Promise<unknown>).then.bind(obj);
            return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
              then(async (value) => {
                await onResolved();
                return value;
              }).then(ok, bad);
          }
          const value: unknown = Reflect.get(obj, key, obj);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            const out: unknown = Reflect.apply(value, obj, args);
            return typeof out === "object" && out !== null ? wrap(out, onResolved) : out;
          };
        },
      });
    const racing = new Proxy(database.db, {
      get(obj, key) {
        const value: unknown = Reflect.get(obj, key, obj);
        if (key !== "select")
          return typeof value === "function" ? (value.bind(obj) as unknown) : value;
        return (...args: unknown[]) => {
          selects += 1;
          const hook =
            selects === 3
              ? async () => {
                  const [v2] = await database.db
                    .insert(questionVersions)
                    .values({
                      difficulty: "sedang",
                      ownerId: USER_A,
                      questionId,
                      versionNo: 2,
                      author: "ai",
                      changeKind: "regenerated",
                      stemMd: "Baru",
                      options: [],
                      answer: {},
                      explanationMd: "x",
                      steps: [],
                      answerRules: null,
                      verificationClaims: [],
                      verificationStatus: "belum_dapat_diverifikasi",
                      createdAt: NOW,
                    })
                    .returning({ id: questionVersions.id });
                  await database.db
                    .update(questions)
                    .set({ currentVersionId: v2.id })
                    .where(eq(questions.id, questionId));
                }
              : undefined;
          return wrap((value as (...a: unknown[]) => object).apply(obj, args), hook);
        };
      },
    }) as unknown as AnyDb;

    const result = await decideQuestion(racing, {
      ownerId: USER_A,
      questionId,
      versionId: v1,
      rowVersion: before.rowVersion,
      action: "approve",
      now: LATER,
    });

    expect(result).toEqual({ ok: false, error: "conflict" });
    const after = await loadQuestion(questionId);
    expect(after.currentVersionId).not.toBe(v1);
    expect(after).toMatchObject({
      status: "draft",
      approvedVersionId: null,
      approvedAt: null,
      rowVersion: before.rowVersion,
    });
  });

  it("conflicts when the question is banked between the read and the update", async () => {
    const { questionId } = await seed();
    const v1 = await versionIdOf(questionId);
    await addRun(v1, "terverifikasi");
    const before = await loadQuestion(questionId);

    // After the third select resolves, a competing save sets banked_at without bumping row_version.
    let selects = 0;
    const wrap = (target: object, onResolved?: () => Promise<void>): object =>
      new Proxy(target, {
        get(obj, key) {
          if (key === "then" && onResolved) {
            const then = (obj as Promise<unknown>).then.bind(obj);
            return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
              then(async (value) => {
                await onResolved();
                return value;
              }).then(ok, bad);
          }
          const value: unknown = Reflect.get(obj, key, obj);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            const out: unknown = Reflect.apply(value, obj, args);
            return typeof out === "object" && out !== null ? wrap(out, onResolved) : out;
          };
        },
      });
    const racing = new Proxy(database.db, {
      get(obj, key) {
        const value: unknown = Reflect.get(obj, key, obj);
        if (key !== "select")
          return typeof value === "function" ? (value.bind(obj) as unknown) : value;
        return (...args: unknown[]) => {
          selects += 1;
          const hook =
            selects === 3
              ? async () => {
                  await database.db
                    .update(questions)
                    .set({ bankedAt: NOW })
                    .where(eq(questions.id, questionId));
                }
              : undefined;
          return wrap((value as (...a: unknown[]) => object).apply(obj, args), hook);
        };
      },
    }) as unknown as AnyDb;

    const result = await decideQuestion(racing, {
      ownerId: USER_A,
      questionId,
      versionId: v1,
      rowVersion: before.rowVersion,
      action: "approve",
      now: LATER,
    });

    expect(result).toEqual({ ok: false, error: "conflict" });
    expect(await loadQuestion(questionId)).toMatchObject({
      status: "draft",
      approvedVersionId: null,
      rowVersion: before.rowVersion,
    });
  });

  it("conflicts on a stale rowVersion", async () => {
    const { questionId } = await seed();
    await addRun(await versionIdOf(questionId), "terverifikasi");
    const result = await decide(questionId, "approve", { rowVersion: 99 });
    expect(result).toEqual({ ok: false, error: "conflict" });
    expect((await loadQuestion(questionId)).status).toBe("draft");
  });

  it("does not overwrite a newer decision made after the first read", async () => {
    const { questionId } = await seed();
    await addRun(await versionIdOf(questionId), "terverifikasi");
    const first = await decide(questionId, "reject");
    expect(first.ok).toBe(true);
    // A second click carrying the pre-reject rowVersion must not approve.
    const second = await decide(questionId, "approve", { rowVersion: 1 });
    expect(second).toEqual({ ok: false, error: "conflict" });
    expect((await loadQuestion(questionId)).status).toBe("archived");
  });

  it("refuses an unchecked question while the job runs, then approves once it succeeded", async () => {
    const { questionId, jobId } = await seed();
    await setJob(jobId, "running");
    expect(await decide(questionId, "approve")).toEqual({
      ok: false,
      error: "not_ready",
    });
    expect((await loadQuestion(questionId)).status).toBe("draft");

    await setJob(jobId, "succeeded");
    expect(await decide(questionId, "approve")).toMatchObject({
      ok: true,
      data: {
        decision: "approved",
      },
    });
  });

  it("refuses an unchecked version while a regeneration of the question is pending", async () => {
    const { questionId, jobId } = await seed();
    await setJob(jobId, "succeeded");
    await database.db.insert(jobs).values({
      ownerId: USER_A,
      type: "regenerate_question",
      payload: { questionId, hint: null },
      status: "running",
    });
    expect(await decide(questionId, "approve")).toEqual({
      ok: false,
      error: "not_ready",
    });
    expect((await loadQuestion(questionId)).status).toBe("draft");
  });

  it.each(["queued", "deferred"])("treats a %s job as not terminal", async (status) => {
    const { questionId, jobId } = await seed();
    await setJob(jobId, status);
    expect(await decide(questionId, "approve")).toEqual({
      ok: false,
      error: "not_ready",
    });
  });

  it.each(["failed", "cancelled"])("treats a %s job as terminal", async (status) => {
    const { questionId, jobId } = await seed();
    await setJob(jobId, status);
    expect(await decide(questionId, "approve")).toMatchObject({ ok: true });
  });

  it("treats a missing job as terminal", async () => {
    const { questionId, requestId } = await seed();
    await database.db
      .update(generationRequests)
      .set({ jobId: null })
      .where(eq(generationRequests.id, requestId));
    expect(await decide(questionId, "approve")).toMatchObject({ ok: true });
  });

  it("approves a version that has a verification run while the job still runs", async () => {
    const { questionId, jobId } = await seed();
    await setJob(jobId, "running");
    await addRun(await versionIdOf(questionId), "terverifikasi");
    expect(await decide(questionId, "approve")).toMatchObject({ ok: true });
  });

  it("ignores a regeneration marker when deriving the status", async () => {
    const { questionId } = await seed();
    const versionId = await versionIdOf(questionId);
    await addRun(versionId, "ketidaksesuaian", NOW);
    await insertRegenerationMarker(db(), {
      ownerId: USER_A,
      versionId,
      now: new Date(NOW.getTime() + 1000),
    });
    // The marker is newer, but the effective status is still the contradiction.
    expect(await decide(questionId, "approve")).toEqual({
      ok: false,
      error: "override_required",
    });
  });

  it("uses the latest real run, not an earlier one", async () => {
    const { questionId } = await seed();
    const versionId = await versionIdOf(questionId);
    await addRun(versionId, "ketidaksesuaian", NOW);
    await addRun(versionId, "terverifikasi", new Date(NOW.getTime() + 1000));
    expect(await decide(questionId, "approve")).toMatchObject({
      ok: true,
      data: {
        override: false,
      },
    });
  });

  it("refuses a first-version contradiction while the job runs (the pipeline may regenerate it)", async () => {
    const { questionId, jobId } = await seed();
    await setJob(jobId, "running");
    await addRun(await versionIdOf(questionId), "ketidaksesuaian");
    expect(await decide(questionId, "approve", { overrideNote: VALID_NOTE })).toEqual({
      ok: false,
      error: "not_ready",
    });
    const q = await loadQuestion(questionId);
    expect(q).toMatchObject({ status: "draft", approvalOverride: null, rowVersion: 1 });

    await setJob(jobId, "succeeded");
    expect(
      await decide(questionId, "approve", { overrideNote: VALID_NOTE }),
    ).toMatchObject({ ok: true, data: { override: true } });
  });

  it("refuses a first version with rejected citations while the job runs (it is about to be replaced)", async () => {
    const { questionId, jobId } = await seed();
    await setJob(jobId, "running");
    const versionId = await versionIdOf(questionId);
    await insertVerificationRun(db(), {
      ownerId: USER_A,
      versionId,
      verifierVersion: "p1-12.1",
      status: "belum_dapat_diverifikasi",
      checks: [
        { type: "numeric_eval", status: "pass", detail: "ok" },
        {
          type: "citation",
          status: "fail",
          detail: "Kutipan bagian materi tidak dikenal.",
        },
      ],
      crossCheck: { provider: "groq", model: "m", verdict: "agree" },
      now: NOW,
    });
    expect(await decide(questionId, "approve")).toEqual({
      ok: false,
      error: "not_ready",
    });
    expect(await loadQuestion(questionId)).toMatchObject({
      status: "draft",
      approvedVersionId: null,
    });

    // Once the one regeneration failed (marker), it may be approved as it is: no contradiction,
    // so no note.
    await insertRegenerationMarker(db(), {
      ownerId: USER_A,
      versionId,
      now: new Date(NOW.getTime() + 1000),
    });
    expect(await decide(questionId, "approve")).toMatchObject({ ok: true });
  });

  it("allows a contradiction while the job runs once a regeneration marker exists", async () => {
    const { questionId, jobId } = await seed();
    await setJob(jobId, "running");
    const versionId = await versionIdOf(questionId);
    await addRun(versionId, "ketidaksesuaian", NOW);
    await insertRegenerationMarker(db(), {
      ownerId: USER_A,
      versionId,
      now: new Date(NOW.getTime() + 1000),
    });
    expect(
      await decide(questionId, "approve", { overrideNote: VALID_NOTE }),
    ).toMatchObject({ ok: true, data: { override: true } });
  });

  it("allows a version 2 contradiction while the job runs", async () => {
    const { questionId, jobId, c, requestId } = await seed();
    await setJob(jobId, "running");
    const saved = await database.db.transaction(async (tx) =>
      persistRegeneratedVersion(tx as unknown as AnyDb, {
        difficulty: "sedang",
        ownerId: USER_A,
        requestId,
        questionId,
        topicId: c.topicId,
        sourceRef: c.sourceRef,
        run: {
          provider: "groq",
          model: "openai/gpt-oss-120b",
          promptVersion: "generate-mc.id@1",
          curriculumVersionId: c.versionId,
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 5,
        },
        question: multipleChoiceQuestionSchema.parse(questionJson(9)),
        now: NOW,
      }),
    );
    await addRun(saved.versionId, "ketidaksesuaian");
    expect(
      await decide(questionId, "approve", { overrideNote: VALID_NOTE }),
    ).toMatchObject({ ok: true, data: { override: true, versionNo: 2 } });
  });

  describe("after a regeneration of an approved question", () => {
    async function approvedThenRegenerated() {
      const { questionId, jobId, c, requestId } = await seed();
      await setJob(jobId, "succeeded");
      await addRun(await versionIdOf(questionId), "ketidaksesuaian");
      const approved = await decide(questionId, "approve", { overrideNote: VALID_NOTE });
      expect(approved).toMatchObject({ ok: true, data: { override: true } });
      const before = await loadQuestion(questionId);
      const saved = await database.db.transaction(async (tx) =>
        persistRegeneratedVersion(tx as unknown as AnyDb, {
          difficulty: "sedang",
          ownerId: USER_A,
          requestId,
          questionId,
          topicId: c.topicId,
          sourceRef: c.sourceRef,
          run: {
            provider: "groq",
            model: "openai/gpt-oss-120b",
            promptVersion: "generate-mc.id@1",
            curriculumVersionId: c.versionId,
            usage: { inputTokens: 1, outputTokens: 1 },
            latencyMs: 5,
          },
          question: multipleChoiceQuestionSchema.parse(questionJson(9)),
          now: NOW,
        }),
      );
      return { questionId, requestId, before, v2: saved.versionId };
    }
    const reviewOf = async (requestId: string) =>
      (await getRequestReview(db(), { ownerId: USER_A, requestId }))!.questions[0];

    it("shows the question as a draft again and approving version 2 replaces the override", async () => {
      const { questionId, requestId, before, v2 } = await approvedThenRegenerated();
      // Regeneration leaves the row version alone, so the guards still pass.
      expect(await loadQuestion(questionId)).toMatchObject({
        status: "approved",
        rowVersion: before.rowVersion,
      });
      expect(await reviewOf(requestId)).toMatchObject({
        versionId: v2,
        decision: "draft",
        override: false,
      });

      // Version 2 is clean: the old override is cleared.
      await addRun(v2, "terverifikasi");
      const result = await decide(questionId, "approve");
      expect(result).toMatchObject({
        ok: true,
        data: { decision: "approved", override: false },
      });
      expect(await loadQuestion(questionId)).toMatchObject({
        status: "approved",
        approvedVersionId: v2,
        approvalOverride: null,
      });
      expect(await reviewOf(requestId)).toMatchObject({
        decision: "approved",
        override: false,
      });
    });

    it("replaces the override with a new note when version 2 is a contradiction", async () => {
      const { questionId, requestId, v2 } = await approvedThenRegenerated();
      await addRun(v2, "ketidaksesuaian");
      const note = "Catatan baru untuk versi dua soal ini.";
      expect(await decide(questionId, "approve", { overrideNote: note })).toMatchObject({
        ok: true,
        data: {
          override: true,
          versionNo: 2,
        },
      });
      expect((await loadQuestion(questionId)).approvalOverride).toMatchObject({
        note,
        versionId: v2,
      });
      expect(await reviewOf(requestId)).toMatchObject({
        decision: "approved",
        override: true,
      });
    });
  });

  it("refuses every action on a banked question", async () => {
    for (const action of ["approve", "reject", "reset"] as const) {
      const { questionId } = await seed();
      await addRun(await versionIdOf(questionId), "terverifikasi");
      expect((await decide(questionId, "approve")).ok).toBe(true);
      await database.db
        .update(questions)
        .set({ bankedAt: NOW })
        .where(eq(questions.id, questionId));
      const before = await loadQuestion(questionId);

      const result = await decide(questionId, action);

      expect(result).toEqual({ ok: false, error: "already_saved" });
      const after = await loadQuestion(questionId);
      expect(after.status).toBe("approved");
      expect(after.rowVersion).toBe(before.rowVersion);
    }
  });

  it("returns not_found for another owner", async () => {
    const { questionId } = await seed();
    await addRun(await versionIdOf(questionId), "terverifikasi");
    const q = await loadQuestion(questionId);
    const result = await decideQuestion(db(), {
      ownerId: USER_B,
      questionId,
      versionId: q.currentVersionId!,
      rowVersion: q.rowVersion,
      action: "approve",
      now: LATER,
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
    expect((await loadQuestion(questionId)).status).toBe("draft");
  });

  it("returns not_found for an unknown question", async () => {
    const result = await decideQuestion(db(), {
      ownerId: USER_A,
      questionId: "99999999-9999-4999-8999-999999999999",
      versionId: "99999999-9999-4999-8999-999999999998",
      rowVersion: 1,
      action: "reject",
      now: LATER,
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("lets reject and reset proceed without any verification run, even while the job runs", async () => {
    const { questionId, jobId } = await seed();
    await setJob(jobId, "running");
    expect(await decide(questionId, "reject")).toMatchObject({ ok: true });
    expect(await decide(questionId, "reset")).toMatchObject({ ok: true });
  });

  it("works through runAsUser (RLS) for the owner and is not_found for another user", async () => {
    const { questionId } = await seed();
    await addRun(await versionIdOf(questionId), "terverifikasi");
    const q = await loadQuestion(questionId);
    const input = {
      questionId,
      versionId: q.currentVersionId!,
      rowVersion: q.rowVersion,
      action: "approve" as const,
      now: LATER,
    };

    const other = await runAsUser(database.db, USER_B, (tx) =>
      decideQuestion(tx as unknown as AnyDb, { ownerId: USER_B, ...input }),
    );
    expect(other).toEqual({ ok: false, error: "not_found" });

    const own = await runAsUser(database.db, USER_A, (tx) =>
      decideQuestion(tx as unknown as AnyDb, { ownerId: USER_A, ...input }),
    );
    expect(own).toMatchObject({ ok: true, data: { decision: "approved" } });
  });
});

describe("RLS column grant", () => {
  it("RLS: authenticated can update approval_override but not stem or current_version_id", async () => {
    const { questionId } = await seed();
    const versionId = await versionIdOf(questionId);

    await runAsUser(database.db, USER_A, (tx) =>
      tx
        .update(questions)
        .set({ approvalOverride: { note: VALID_NOTE } })
        .where(eq(questions.id, questionId)),
    );
    expect((await loadQuestion(questionId)).approvalOverride).toEqual({
      note: VALID_NOTE,
    });

    const denied = async (statement: ReturnType<typeof sql.raw>) => {
      try {
        await runAsUser(database.db, USER_A, (tx) => tx.execute(statement));
      } catch (error) {
        let text = "";
        let current: unknown = error;
        while (current instanceof Error) {
          text += `${current.message} | `;
          current = current.cause;
        }
        return text;
      }
      throw new Error("expected the statement to fail");
    };
    expect(
      await denied(
        sql.raw(
          `update questions set current_version_id = '${versionId}' where id = '${questionId}'`,
        ),
      ),
    ).toMatch(/permission denied/i);
    expect(
      await denied(
        sql.raw(`update question_versions set stem_md = 'x' where id = '${versionId}'`),
      ),
    ).toMatch(/permission denied/i);
  });
});
