import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AiProviderError,
  createFakeProvider,
  createGateway,
  defaultRouting,
} from "@/lib/ai";
import {
  aiCalls,
  auditLog,
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
import { REGENERATE_JOB_TYPE } from "../schema/regenerate-input";
import { multipleChoiceQuestionSchema } from "../schema/schemas";
import { persistDrafts, type AnyDb } from "./persist";
import {
  GENERATE_QUOTA,
  jakartaDayWindow,
  questionsRequestedToday,
  USER_DAILY_QUESTION_LIMIT,
} from "./quota";
import {
  bankQuerySchema,
  getBankCount,
  getBankList,
  getBankQuestion,
} from "@/features/bank";
import {
  createRegenerateQuestionHandler,
  requestRegeneration,
  settleStrandedApprovals,
} from "./regenerate";
import { createGenerationRequest } from "./request";
import {
  buildContext,
  questionJson,
  seedCurriculum,
  seedGenerationRequest,
  solverPicking,
  solverWrong,
} from "./test-support";
import { insertVerificationRun } from "./verify-persist";

let database: TestDatabase;
const NOW = new Date("2026-11-08T03:00:00.000Z");
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
  await d.delete(auditLog);
  await d.delete(generationRequests);
  await d.delete(jobs);
  await d.delete(learningObjectives);
  await d.delete(topics);
  await d.delete(cpElements);
  await d.delete(curriculumVersions);
});

// One verified question (v1: "Hitung $1 + 1$.") whose generation job has finished.
async function seed(ownerId = USER_A) {
  const c = await seedCurriculum(database.db);
  const { requestId, jobId } = await seedGenerationRequest(database.db, {
    ownerId,
    quantity: 1,
    ...c,
  });
  // The seeded request is the day's first: it counts one question, made yesterday so the daily
  // limit tests start from zero.
  await database.db
    .update(generationRequests)
    .set({ createdAt: new Date(NOW.getTime() - 86_400_000) })
    .where(eq(generationRequests.id, requestId));
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
        model: GENERATE_QUOTA.model,
        promptVersion: "generate-mc.id@2",
        curriculumVersionId: c.versionId,
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 5,
      },
      questions: [multipleChoiceQuestionSchema.parse(questionJson(1))],
      now: NOW,
    }),
  );
  const questionId = saved.questionIds[0];
  const q = await loadQuestion(questionId);
  await insertVerificationRun(db(), {
    ownerId,
    versionId: q.currentVersionId ?? "",
    verifierVersion: "v1",
    status: "dicek_silang",
    checks: [],
    crossCheck: { verdict: "agree" },
    now: NOW,
  });
  await database.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.id, jobId));
  return { questionId, requestId, jobId, c };
}

const loadQuestion = async (questionId: string) =>
  (await database.db.select().from(questions).where(eq(questions.id, questionId)))[0];
const versionsOf = (questionId: string) =>
  database.db
    .select()
    .from(questionVersions)
    .where(eq(questionVersions.questionId, questionId))
    .orderBy(asc(questionVersions.versionNo));
const runsOf = (versionId: string) =>
  database.db
    .select()
    .from(verificationRuns)
    .where(eq(verificationRuns.questionVersionId, versionId));
const loadJob = async (jobId: string) =>
  (await database.db.select().from(jobs).where(eq(jobs.id, jobId)))[0];

const replacement = (n: number) => JSON.stringify({ questions: [questionJson(n)] });
// A question whose only claim the verifier cannot evaluate (no claim passes).
const unsupportedClaim = (n: number) => ({
  ...questionJson(n),
  verification_claims: [
    { type: "numeric_eval", expression: `${String(n)}+${String(n)}`, expected: "dua" },
  ],
});

function handlerWith(responses: Parameters<typeof createFakeProvider>[1]) {
  const provider = createFakeProvider("groq", responses);
  const handler = createRegenerateQuestionHandler({
    db: db(),
    createGateway: (budget) =>
      createGateway({ routing: defaultRouting, providers: { groq: provider }, budget }),
    now: () => NOW,
  });
  return { provider, handler };
}

async function request(
  questionId: string,
  hint: Parameters<typeof requestRegeneration>[1]["hint"] = null,
  ownerId = USER_A,
) {
  return requestRegeneration(db(), { ownerId, questionId, hint, now: NOW });
}

async function runJob(jobId: string, responses: Parameters<typeof handlerWith>[0]) {
  const { provider, handler } = handlerWith(responses);
  const result = await handler(await buildContext(database.db, jobId, { now: NOW }));
  return { provider, result };
}

async function approve(questionId: string, banked: boolean) {
  const q = await loadQuestion(questionId);
  await database.db
    .update(questions)
    .set({
      status: "approved",
      approvedVersionId: q.currentVersionId,
      approvedAt: NOW,
      bankedAt: banked ? NOW : null,
    })
    .where(eq(questions.id, questionId));
}

// Uses up the generation model's whole daily budget an hour before NOW.
async function exhaustQuota() {
  await database.db.insert(aiCalls).values({
    ownerId: USER_A,
    task: "generate_questions",
    provider: "groq",
    model: GENERATE_QUOTA.model,
    promptVersion: "x",
    inputTokens: GENERATE_QUOTA.perDay,
    outputTokens: 0,
    outcome: "ok",
    createdAt: new Date(NOW.getTime() - 3_600_000),
  });
}

describe("regenerate one question", () => {
  it(
    "regenerate creates version n+1 and keeps n",
    async () => {
      const { questionId } = await seed();
      const [v1] = await versionsOf(questionId);
      const before = await loadQuestion(questionId);

      const queued = await request(questionId);
      expect(queued).toMatchObject({ ok: true, data: { deferredUntil: null } });
      if (!queued.ok) return;
      const job = await loadJob(queued.data.jobId);
      expect(job).toMatchObject({
        type: REGENERATE_JOB_TYPE,
        status: "queued",
        payload: { questionId, hint: null },
      });

      const { result, provider } = await runJob(queued.data.jobId, [
        replacement(7),
        solverPicking("B", "14"),
      ]);
      expect(result.kind).toBe("done");
      // One generation call, then the independent cross-check of the new version.
      expect(provider.calls).toHaveLength(2);

      const versions = await versionsOf(questionId);
      expect(versions.map((v) => v.versionNo)).toEqual([1, 2]);
      expect(versions[0]).toEqual(v1);
      expect(versions[1]).toMatchObject({
        author: "ai",
        changeKind: "regenerated",
        stemMd: "Hitung $7 + 7$.",
      });
      const after = await loadQuestion(questionId);
      expect(after.currentVersionId).toBe(versions[1].id);
      expect(after.rowVersion).toBe(before.rowVersion + 1);
      expect(after.searchText).toContain("hitung");
      expect(after.searchText).toContain("7 + 7");
      // Full verification, cross-check included.
      const runs = await runsOf(versions[1].id);
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("terverifikasi");
      expect(runs[0].crossCheck).toMatchObject({ verdict: "agree" });

      // n+1 from the latest number, not a fixed "2". (The runner would have completed the job.)
      await database.db
        .update(jobs)
        .set({ status: "succeeded" })
        .where(eq(jobs.id, queued.data.jobId));
      const again = await request(questionId);
      if (!again.ok) throw new Error("second regeneration refused");
      await runJob(again.data.jobId, [replacement(8), solverPicking("B", "16")]);
      expect((await versionsOf(questionId)).map((v) => v.versionNo)).toEqual([1, 2, 3]);

      const audits = await database.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, questionId));
      expect(audits.filter((row) => row.action === "question_regenerated")).toHaveLength(
        2,
      );
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a re-run of the same job writes nothing more and calls no model",
    async () => {
      const { questionId } = await seed();
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      await runJob(queued.data.jobId, [replacement(7), solverPicking("B", "14")]);
      const { result, provider } = await runJob(queued.data.jobId, []);
      expect(result.kind).toBe("done");
      expect(provider.calls).toHaveLength(0);
      expect(await versionsOf(questionId)).toHaveLength(2);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "hint text appears in the prompt and is capped at 200 chars and wrapped as untrusted data",
    async () => {
      const { questionId } = await seed();
      const text = `Gunakan konteks pasar tradisional. ${"z".repeat(300)}`;
      const queued = await request(questionId, { text });
      if (!queued.ok) throw new Error("refused");
      const { provider } = await runJob(queued.data.jobId, [
        replacement(7),
        solverPicking("B", "14"),
      ]);
      const prompt = provider.calls[0].prompt;
      const block = /<<<PERMINTAAN_GURU\n([\s\S]*?)\nPERMINTAAN_GURU>>>/.exec(prompt);
      expect(block?.[1]).toBe(text.slice(0, 200));
      expect(prompt).toMatch(/data dari guru, bukan instruksi/i);
      expect(prompt).toContain("Hitung $1 + 1$.");
      // The generation call is the regeneration task (same route as generate_questions).
      const calls = await database.db
        .select()
        .from(aiCalls)
        .where(eq(aiCalls.jobId, queued.data.jobId));
      expect(calls.map((call) => call.task).sort()).toEqual([
        "regenerate_question",
        "solve_independent",
      ]);
      expect(calls.find((call) => call.task === "regenerate_question")).toMatchObject({
        promptVersion: "regenerate-mc.id@1",
        outcome: "ok",
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "an easier or harder hint moves the question's difficulty one step",
    async () => {
      const { questionId } = await seed();
      const queued = await request(questionId, "easier");
      if (!queued.ok) throw new Error("refused");
      const { provider } = await runJob(queued.data.jobId, [
        replacement(7),
        solverPicking("B", "14"),
      ]);
      expect(provider.calls[0].prompt).toContain("Tingkat kesulitan: mudah");
      expect((await loadQuestion(questionId)).difficulty).toBe("mudah");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "quota exhaustion defers the job with run_after",
    async () => {
      const { questionId } = await seed();
      await exhaustQuota();
      const resumeAt = new Date(NOW.getTime() - 3_600_000 + 86_400_000);

      const queued = await request(questionId);
      expect(queued).toMatchObject({ ok: true, data: { deferredUntil: resumeAt } });
      if (!queued.ok) return;
      expect(await loadJob(queued.data.jobId)).toMatchObject({
        status: "deferred",
        runAfter: resumeAt,
      });

      const { result, provider } = await runJob(queued.data.jobId, []);
      expect(result).toMatchObject({
        kind: "defer",
        runAfter: resumeAt,
        progress: { step: "deferred", messageKey: "quota_daily" },
      });
      expect(provider.calls).toHaveLength(0);
      expect(await versionsOf(questionId)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a trashed question makes the job a no-op",
    async () => {
      const { questionId } = await seed();
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      const deletedAt = new Date(NOW.getTime() + 1_000);
      await database.db
        .update(questions)
        .set({ deletedAt, purgeAfter: new Date(deletedAt.getTime() + 30 * 86_400_000) })
        .where(eq(questions.id, questionId));
      const before = await loadQuestion(questionId);

      const { result, provider } = await runJob(queued.data.jobId, [replacement(7)]);
      expect(result.kind).toBe("done");
      expect(provider.calls).toHaveLength(0);
      expect(await versionsOf(questionId)).toHaveLength(1);
      expect(await loadQuestion(questionId)).toEqual(before);

      // A trashed question cannot be queued either.
      expect(await request(questionId)).toEqual({
        ok: false,
        error: { reason: "trashed" },
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a job naming another teacher's question is a no-op, and the request is refused",
    async () => {
      const { questionId } = await seed(USER_A);
      expect(await request(questionId, null, USER_B)).toEqual({
        ok: false,
        error: { reason: "not_found" },
      });
      // A job row of user B that names A's question (never created by the service).
      const [job] = await database.db
        .insert(jobs)
        .values({
          ownerId: USER_B,
          type: REGENERATE_JOB_TYPE,
          payload: { questionId, hint: null },
          status: "running",
        })
        .returning({ id: jobs.id });
      const { result, provider } = await runJob(job.id, [replacement(7)]);
      expect(result.kind).toBe("done");
      expect(provider.calls).toHaveLength(0);
      expect(await versionsOf(questionId)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "counts one question toward the user's daily limit",
    async () => {
      const { questionId, c } = await seed();
      expect(await questionsRequestedToday(db(), USER_A, NOW)).toBe(0);
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      expect(await questionsRequestedToday(db(), USER_A, NOW)).toBe(1);
      await database.db
        .update(jobs)
        .set({ status: "succeeded" })
        .where(eq(jobs.id, queued.data.jobId));

      // 28 more questions today: 29 used, one left.
      await database.db.insert(generationRequests).values(
        [5, 5, 5, 5, 5, 3].map((quantity) => ({
          ownerId: USER_A,
          status: "cancelled",
          params: { quantity },
          createdAt: NOW,
        })),
      );
      const last = await request(questionId);
      expect(last.ok).toBe(true);
      if (!last.ok) return;
      await database.db
        .update(jobs)
        .set({ status: "succeeded" })
        .where(eq(jobs.id, last.data.jobId));
      expect(await questionsRequestedToday(db(), USER_A, NOW)).toBe(
        USER_DAILY_QUESTION_LIMIT,
      );

      expect(await request(questionId)).toEqual({
        ok: false,
        error: {
          reason: "daily_limit",
          limit: USER_DAILY_QUESTION_LIMIT,
          used: USER_DAILY_QUESTION_LIMIT,
          remaining: 0,
          resetsAt: jakartaDayWindow(NOW).end,
        },
      });
      // A regeneration uses the same allowance as a new request.
      const generation = await createGenerationRequest(db(), {
        ownerId: USER_A,
        topic: { id: c.topicId, stableKey: "spldv", title: "SPLDV" },
        curriculumVersionId: c.versionId,
        quantity: 1,
        difficulty: "sedang",
        now: NOW,
      });
      expect(generation).toMatchObject({ ok: false, error: { reason: "daily_limit" } });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a second regenerate while one is pending is refused with the pending job",
    async () => {
      const { questionId } = await seed();
      const first = await request(questionId, "harder");
      if (!first.ok) throw new Error("refused");
      expect(await request(questionId, "easier")).toEqual({
        ok: false,
        error: { reason: "pending", jobId: first.data.jobId },
      });
      // The refused request used none of the allowance.
      expect(await questionsRequestedToday(db(), USER_A, NOW)).toBe(1);
      await runJob(first.data.jobId, [replacement(7), solverPicking("B", "14")]);
      await database.db
        .update(jobs)
        .set({ status: "succeeded" })
        .where(eq(jobs.id, first.data.jobId));
      expect((await request(questionId)).ok).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "waits for the question's own generation job to finish",
    async () => {
      const { questionId, jobId } = await seed();
      await database.db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId));
      expect(await request(questionId)).toEqual({
        ok: false,
        error: { reason: "not_ready" },
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a failed generation leaves the question and its versions untouched",
    async () => {
      const { questionId } = await seed();
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      const before = await loadQuestion(questionId);
      const { handler } = handlerWith(["not json", "still not json"]);
      await expect(
        handler(await buildContext(database.db, queued.data.jobId, { now: NOW })),
      ).rejects.toMatchObject({ code: "invalid_output" });
      expect(await loadQuestion(questionId)).toEqual(before);
      expect(await versionsOf(questionId)).toHaveLength(1);
      const calls = await database.db
        .select()
        .from(aiCalls)
        .where(eq(aiCalls.jobId, queued.data.jobId));
      expect(calls).toMatchObject([
        { task: "regenerate_question", outcome: "error", errorCode: "invalid_output" },
      ]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a question trashed while the model answers gets no new version",
    async () => {
      const { questionId } = await seed();
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      const provider = createFakeProvider("groq", [replacement(7)]);
      // PGlite has one session: the "other tab" writes through the job's own open transaction, which
      // is what a concurrent committed write looks like to the savepoint's fresh read.
      let open: AnyDb | null = null;
      const real = db();
      const watched = new Proxy(real, {
        get(target, key, receiver) {
          if (key === "transaction") {
            return (fn: (tx: AnyDb) => Promise<unknown>) =>
              real.transaction((tx) => {
                open = tx;
                return fn(tx);
              });
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      const handler = createRegenerateQuestionHandler({
        db: watched,
        createGateway: (budget) => {
          const gateway = createGateway({
            routing: defaultRouting,
            providers: { groq: provider },
            budget,
          });
          return {
            ...gateway,
            generate: async (request) => {
              const result = await gateway.generate(request);
              // The teacher trashes the question while the call is in flight.
              if (!open) throw new Error("no open transaction");
              await open
                .update(questions)
                .set({ deletedAt: NOW, purgeAfter: NOW })
                .where(eq(questions.id, questionId));
              return result;
            },
          };
        },
        now: () => NOW,
      });
      const result = await handler(
        await buildContext(database.db, queued.data.jobId, { now: NOW }),
      );
      expect(result).toMatchObject({ kind: "done", progress: { step: "skipped" } });
      expect(await versionsOf(questionId)).toHaveLength(1);
      // The tokens are still recorded, but not as a saved regeneration.
      const calls = await database.db
        .select()
        .from(aiCalls)
        .where(eq(aiCalls.jobId, queued.data.jobId));
      expect(calls).toMatchObject([{ outcome: "error", errorCode: "question_gone" }]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a run that stopped after saving resumes by verifying only",
    async () => {
      const { questionId } = await seed();
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      // Saved, then stopped before the cross-check (here a throttled solver).
      await runJob(queued.data.jobId, [
        replacement(7),
        new AiProviderError("rate_limited", "busy", { retryAfterMs: 60_000 }),
      ]);
      const saved = await versionsOf(questionId);
      expect(saved).toHaveLength(2);
      expect(await runsOf(saved[1].id)).toHaveLength(0);

      const { provider, result } = await runJob(queued.data.jobId, [
        solverPicking("B", "14"),
      ]);
      expect(result.kind).toBe("done");
      // One call, the solver's: the generator is not asked again.
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].model).toBe(defaultRouting.solve_independent[0].model);
      expect(await versionsOf(questionId)).toHaveLength(2);
      expect(await runsOf(saved[1].id)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a question trashed after its new version was saved is not cross-checked and is settled",
    async () => {
      const { questionId } = await seed();
      await approve(questionId, true);
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      await runJob(queued.data.jobId, [
        replacement(7),
        new AiProviderError("rate_limited", "busy", { retryAfterMs: 60_000 }),
      ]);
      await database.db
        .update(questions)
        .set({ deletedAt: NOW, purgeAfter: NOW })
        .where(eq(questions.id, questionId));
      const { provider, result } = await runJob(queued.data.jobId, [
        solverPicking("B", "14"),
      ]);
      expect(result).toMatchObject({ kind: "done", progress: { step: "skipped" } });
      expect(provider.calls).toHaveLength(0);
      // R19: the never-verified version gets no approval, and a later restore from the trash
      // finds the question back in review instead of approved but out of the bank.
      expect(await loadQuestion(questionId)).toMatchObject({
        status: "draft",
        approvedVersionId: null,
        bankedAt: null,
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "two requests at the same time make one job, the other gets the pending job",
    async () => {
      const { questionId } = await seed();
      const results = await Promise.all([request(questionId), request(questionId)]);
      const created = results.filter((result) => result.ok);
      const pending = results.filter(
        (result) => !result.ok && result.error.reason === "pending",
      );
      expect(created).toHaveLength(1);
      expect(pending).toHaveLength(1);
      const jobsOf = await database.db
        .select()
        .from(jobs)
        .where(eq(jobs.type, "regenerate_question"));
      expect(jobsOf).toHaveLength(1);
      expect(await questionsRequestedToday(db(), USER_A, NOW)).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );

  // R10 (revised): an approval never moves to an AI version nobody has checked. It stays on the
  // old version while the job runs and moves only when the new version is verified or
  // cross-checked; anything else (mismatch, no signal, no run at all) clears it.
  it(
    "keeps the approval on the old version until the new one is verified",
    async () => {
      const { questionId } = await seed();
      await approve(questionId, true);
      const v1 = (await loadQuestion(questionId)).currentVersionId;
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      // The cross-check is throttled: the job waits with the new version saved but unchecked.
      const { result } = await runJob(queued.data.jobId, [
        replacement(7),
        new AiProviderError("rate_limited", "busy", { retryAfterMs: 60_000 }),
      ]);
      expect(result.kind).toBe("defer");
      const waiting = await loadQuestion(questionId);
      expect(waiting.currentVersionId).not.toBe(v1);
      expect(waiting.approvedVersionId).toBe(v1);
      expect(waiting.approvedAt).toEqual(NOW);
      // R19: meanwhile the bank still lists it, with the approved version's content.
      const list = await getBankList(db(), {
        ownerId: USER_A,
        query: bankQuerySchema.parse({}),
      });
      expect(list.items.map((item) => item.questionId)).toEqual([questionId]);
      expect(await getBankCount(db(), { ownerId: USER_A })).toBe(1);
      const detail = await getBankQuestion(db(), { ownerId: USER_A, questionId });
      expect(detail?.question.stemMd).toBe("Hitung $1 + 1$.");
      expect(detail?.question.versionId).toBe(v1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "moves a banked question's approval to the new version once it is verified",
    async () => {
      const { questionId } = await seed();
      await approve(questionId, true);
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      const { result } = await runJob(queued.data.jobId, [
        replacement(7),
        solverPicking("B", "14"),
      ]);
      expect(result).toMatchObject({ kind: "done", progress: { step: "saved" } });
      const after = await loadQuestion(questionId);
      expect(after.status).toBe("approved");
      expect(after.bankedAt).not.toBeNull();
      expect(after.approvedVersionId).toBe(after.currentVersionId);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "an approved question that is not banked returns to draft when regenerated",
    async () => {
      const { questionId } = await seed();
      await approve(questionId, false);
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      // Already at save, before any check (like a teacher edit, R19).
      await runJob(queued.data.jobId, [
        replacement(7),
        new AiProviderError("rate_limited", "busy", { retryAfterMs: 60_000 }),
      ]);
      expect(await loadQuestion(questionId)).toMatchObject({
        status: "draft",
        approvedVersionId: null,
        approvedAt: null,
        bankedAt: null,
      });
      // A verified new version does not bring the approval back.
      await runJob(queued.data.jobId, [solverPicking("B", "14")]);
      expect(await loadQuestion(questionId)).toMatchObject({
        status: "draft",
        approvedVersionId: null,
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "settles a regeneration that died on its last attempt (the daily sweep)",
    async () => {
      const { questionId } = await seed();
      await approve(questionId, true);
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      await runJob(queued.data.jobId, [
        replacement(7),
        new AiProviderError("rate_limited", "busy", { retryAfterMs: 60_000 }),
      ]);
      // While the job can still run, the sweep leaves it alone.
      expect(await settleStrandedApprovals(db(), NOW)).toBe(0);
      expect((await loadQuestion(questionId)).bankedAt).not.toBeNull();

      // The runner gave up (lease expired on the last attempt): no handler catch ran.
      await database.db
        .update(jobs)
        .set({ status: "failed" })
        .where(eq(jobs.id, queued.data.jobId));
      expect(await settleStrandedApprovals(db(), NOW)).toBe(1);
      expect(await loadQuestion(questionId)).toMatchObject({
        status: "draft",
        approvedVersionId: null,
        bankedAt: null,
      });
      expect(await settleStrandedApprovals(db(), NOW)).toBe(0);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "the sweep moves the approval when the stranded new version was verified",
    async () => {
      const { questionId } = await seed();
      await approve(questionId, true);
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      await runJob(queued.data.jobId, [
        replacement(7),
        new AiProviderError("rate_limited", "busy", { retryAfterMs: 60_000 }),
      ]);
      const q = await loadQuestion(questionId);
      await insertVerificationRun(db(), {
        ownerId: USER_A,
        versionId: q.currentVersionId ?? "",
        verifierVersion: "v1",
        status: "terverifikasi",
        checks: [],
        crossCheck: { verdict: "agree" },
        now: NOW,
      });
      await database.db
        .update(jobs)
        .set({ status: "failed" })
        .where(eq(jobs.id, queued.data.jobId));
      expect(await settleStrandedApprovals(db(), NOW)).toBe(1);
      const after = await loadQuestion(questionId);
      expect(after.approvedVersionId).toBe(after.currentVersionId);
      expect(after.bankedAt).not.toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a banked question whose new version is contradicted leaves the bank for review",
    async () => {
      const { questionId } = await seed();
      await approve(questionId, true);
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      const { result } = await runJob(queued.data.jobId, [replacement(7), solverWrong()]);
      expect(result).toMatchObject({
        kind: "done",
        progress: { step: "returned_to_review" },
      });
      const after = await loadQuestion(questionId);
      expect(after).toMatchObject({
        status: "draft",
        approvedVersionId: null,
        bankedAt: null,
      });
      const runs = await runsOf(after.currentVersionId ?? "");
      expect(runs[0].status).toBe("ketidaksesuaian");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "clears the approval when the new version cannot be verified (no signal)",
    async () => {
      const { questionId } = await seed();
      await approve(questionId, true);
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      // No claim passes and the solver gives nothing usable: belum_dapat_diverifikasi.
      const { result } = await runJob(queued.data.jobId, [
        JSON.stringify({ questions: [unsupportedClaim(7)] }),
        "not json",
        "still not json",
      ]);
      expect(result).toMatchObject({
        kind: "done",
        progress: { step: "returned_to_review" },
      });
      const after = await loadQuestion(questionId);
      expect((await runsOf(after.currentVersionId ?? ""))[0].status).toBe(
        "belum_dapat_diverifikasi",
      );
      expect(after).toMatchObject({
        status: "draft",
        approvedVersionId: null,
        approvedAt: null,
        bankedAt: null,
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "a job that fails before verifying carries no approval to the new version",
    async () => {
      const { questionId } = await seed();
      await approve(questionId, true);
      const queued = await request(questionId);
      if (!queued.ok) throw new Error("refused");
      await runJob(queued.data.jobId, [
        replacement(7),
        new AiProviderError("rate_limited", "busy", { retryAfterMs: 60_000 }),
      ]);
      // Last attempt, and the database fails during verification.
      const broken = new Proxy(db(), {
        get(target, key, receiver) {
          if (key === "transaction") {
            return () => Promise.reject(new Error("connection lost"));
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      const provider = createFakeProvider("groq", []);
      const handler = createRegenerateQuestionHandler({
        db: broken,
        createGateway: (budget) =>
          createGateway({
            routing: defaultRouting,
            providers: { groq: provider },
            budget,
          }),
        now: () => NOW,
      });
      const ctx = await buildContext(database.db, queued.data.jobId, {
        now: NOW,
        attempts: 2,
        maxAttempts: 3,
      });
      await expect(handler(ctx)).rejects.toMatchObject({ code: "system_error" });
      const after = await loadQuestion(questionId);
      expect(after.currentVersionId).not.toBeNull();
      expect(await runsOf(after.currentVersionId ?? "")).toHaveLength(0);
      expect(after).toMatchObject({
        status: "draft",
        approvedVersionId: null,
        approvedAt: null,
        bankedAt: null,
      });
    },
    DB_TEST_TIMEOUT,
  );
});
