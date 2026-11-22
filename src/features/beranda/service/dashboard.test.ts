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
import { getDashboard } from "./dashboard";
import { persistDrafts, type AnyDb } from "@/features/generation";
import { multipleChoiceQuestionSchema } from "@/features/generation";
import {
  questionJson,
  seedCurriculum,
  seedGenerationRequest,
} from "@/features/generation";
import { persistRegeneratedVersion } from "@/features/generation";

let database: TestDatabase;
const NOW = new Date("2026-11-08T10:00:00.000Z");
const LATER = new Date("2026-11-08T11:00:00.000Z");

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

type Curriculum = Awaited<ReturnType<typeof seedCurriculum>>;
const RUN = (c: Curriculum) => ({
  provider: "groq",
  model: "openai/gpt-oss-120b",
  promptVersion: "generate-mc.id@1",
  curriculumVersionId: c.versionId,
  usage: { inputTokens: 1, outputTokens: 1 },
  latencyMs: 5,
});
const handle = () => database.db as unknown as AnyDb;
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

// A request with `count` draft questions; the job is "succeeded" unless `jobStatus` says otherwise.
async function seedRequest(
  c: Curriculum,
  ownerId: string,
  count: number,
  options: { jobStatus?: string; createdAt?: Date; params?: unknown } = {},
) {
  const { requestId, jobId } = await seedGenerationRequest(database.db, {
    ownerId,
    quantity: Math.max(1, Math.min(count, 5)),
    params: options.params,
    ...c,
  });
  let ids: string[] = [];
  if (count > 0) {
    const saved = await database.db.transaction(async (tx) =>
      persistDrafts(tx as unknown as AnyDb, {
        ownerId,
        requestId,
        topicId: c.topicId,
        sourceRef: c.sourceRef,
        grade: 8,
        difficulty: "sedang",
        run: RUN(c),
        questions: Array.from({ length: count }, (_, i) =>
          multipleChoiceQuestionSchema.parse(questionJson(i + 1)),
        ),
        now: NOW,
      }),
    );
    ids = saved.questionIds;
  }
  await database.db
    .update(jobs)
    .set({ status: options.jobStatus ?? "succeeded" })
    .where(eq(jobs.id, jobId));
  if (options.createdAt) {
    await database.db
      .update(generationRequests)
      .set({ createdAt: options.createdAt })
      .where(eq(generationRequests.id, requestId));
  }
  return { requestId, jobId, ids };
}

const load = async (id: string) => {
  const [q] = await database.db.select().from(questions).where(eq(questions.id, id));
  return q;
};
async function approve(id: string) {
  const q = await load(id);
  await database.db
    .update(questions)
    .set({ status: "approved", approvedVersionId: q.currentVersionId, approvedAt: NOW })
    .where(eq(questions.id, id));
}
async function bank(id: string) {
  await database.db
    .update(questions)
    .set({ bankedAt: LATER })
    .where(eq(questions.id, id));
}
async function setStatus(id: string, status: string) {
  await database.db.update(questions).set({ status }).where(eq(questions.id, id));
}
async function regenerate(c: Curriculum, requestId: string, questionId: string) {
  await database.db.transaction(async (tx) =>
    persistRegeneratedVersion(tx as unknown as AnyDb, {
      difficulty: "sedang",
      ownerId: USER_A,
      requestId,
      questionId,
      topicId: c.topicId,
      sourceRef: c.sourceRef,
      run: RUN(c),
      question: multipleChoiceQuestionSchema.parse(questionJson(9)),
      now: NOW,
    }),
  );
}

describe("getDashboard", () => {
  it("is empty for a teacher without requests", async () => {
    await seedCurriculum(database.db);
    expect(await getDashboard(handle(), { ownerId: USER_A })).toEqual({
      hasActivity: false,
      running: [],
      pending: [],
      bankedCount: 0,
      undecidedTotal: 0,
    });
  });

  it("lists a running request under running only", async () => {
    const c = await seedCurriculum(database.db);
    const r = await seedRequest(c, USER_A, 0, { jobStatus: "running" });
    await database.db
      .update(jobs)
      .set({ progress: { step: "generating", done: 1, total: 3 } })
      .where(eq(jobs.id, r.jobId));
    const dash = await getDashboard(handle(), { ownerId: USER_A });
    expect(dash.hasActivity).toBe(true);
    expect(dash.pending).toEqual([]);
    expect(dash.running).toEqual([
      {
        requestId: r.requestId,
        topicTitle: "SPLDV",
        quantity: 1,
        createdAt: expect.any(String) as unknown,
        jobStatus: "running",
        runAfter: null,
        progress: { done: 1, total: 3 },
        messageKey: null,
      },
    ]);
  });

  it("lists a deferred job with its resume time and message key", async () => {
    const c = await seedCurriculum(database.db);
    const r = await seedRequest(c, USER_A, 0, { jobStatus: "deferred" });
    await database.db
      .update(jobs)
      .set({
        runAfter: LATER,
        progress: { step: "deferred", done: 0, total: 3, messageKey: "quota_daily" },
      })
      .where(eq(jobs.id, r.jobId));
    const dash = await getDashboard(handle(), { ownerId: USER_A });
    expect(dash.running).toHaveLength(1);
    expect(dash.running[0]).toMatchObject({
      jobStatus: "deferred",
      runAfter: LATER.toISOString(),
      messageKey: "quota_daily",
      progress: { done: 0, total: 3 },
    });
  });

  it("lists a finished request with undecided and approved-unsaved questions as pending", async () => {
    const c = await seedCurriculum(database.db);
    const r = await seedRequest(c, USER_A, 5);
    await approve(r.ids[0]);
    await approve(r.ids[1]);
    await setStatus(r.ids[2], "archived");
    const dash = await getDashboard(handle(), { ownerId: USER_A });
    expect(dash.running).toEqual([]);
    expect(dash.pending).toEqual([
      {
        requestId: r.requestId,
        topicTitle: "SPLDV",
        quantity: 5,
        createdAt: expect.any(String) as unknown,
        undecided: 2,
        readyToSave: 2,
      },
    ]);
  });

  it("keeps running requests out of pending", async () => {
    const c = await seedCurriculum(database.db);
    const r = await seedRequest(c, USER_A, 3, { jobStatus: "running" });
    const dash = await getDashboard(handle(), { ownerId: USER_A });
    expect(dash.running.map((i) => i.requestId)).toEqual([r.requestId]);
    expect(dash.pending).toEqual([]);
  });

  it("omits decided and banked requests", async () => {
    const c = await seedCurriculum(database.db);
    const rejected = await seedRequest(c, USER_A, 2);
    for (const id of rejected.ids) await setStatus(id, "archived");
    const saved = await seedRequest(c, USER_A, 2);
    for (const id of saved.ids) {
      await approve(id);
      await bank(id);
    }
    const dash = await getDashboard(handle(), { ownerId: USER_A });
    expect(dash.hasActivity).toBe(true);
    expect(dash.running).toEqual([]);
    expect(dash.pending).toEqual([]);
    expect(dash.bankedCount).toBe(2);
  });

  it("counts a question regenerated after approval as not ready to save", async () => {
    const c = await seedCurriculum(database.db);
    const r = await seedRequest(c, USER_A, 1);
    await approve(r.ids[0]);
    await regenerate(c, r.requestId, r.ids[0]);
    const q = await load(r.ids[0]);
    expect(q.approvedVersionId).not.toBe(q.currentVersionId);
    const dash = await getDashboard(handle(), { ownerId: USER_A });
    expect(dash.pending).toHaveLength(1);
    expect(dash.pending[0]).toMatchObject({ readyToSave: 0 });
    // The status stays "approved" but the approval is stale, so it reads as undecided again.
    expect(q.status).toBe("approved");
    expect(dash.pending[0]).toMatchObject({ undecided: 1 });
  });

  it("never includes another owner's data", async () => {
    const c = await seedCurriculum(database.db);
    const mine = await seedRequest(c, USER_A, 1);
    await seedRequest(c, USER_B, 2);
    const theirsRunning = await seedRequest(c, USER_B, 0, { jobStatus: "running" });
    const theirsBanked = await seedRequest(c, USER_B, 1);
    await approve(theirsBanked.ids[0]);
    await bank(theirsBanked.ids[0]);
    const dash = await getDashboard(handle(), { ownerId: USER_A });
    expect(dash.pending.map((i) => i.requestId)).toEqual([mine.requestId]);
    expect(dash.pending[0]).toMatchObject({ undecided: 1 });
    expect(dash.running).toEqual([]);
    expect(dash.bankedCount).toBe(0);
    const other = await getDashboard(handle(), { ownerId: USER_B });
    expect(other.running.map((i) => i.requestId)).toEqual([theirsRunning.requestId]);
    expect(other.bankedCount).toBe(1);
    expect(other.pending.map((i) => i.undecided)).toEqual([2]);
  });

  it("caps each section at 5, newest first", async () => {
    const c = await seedCurriculum(database.db);
    const made: string[] = [];
    for (let i = 0; i < 7; i++) {
      made.push((await seedRequest(c, USER_A, 1, { createdAt: at(i) })).requestId);
    }
    const runningMade: string[] = [];
    for (let i = 0; i < 7; i++) {
      runningMade.push(
        (await seedRequest(c, USER_A, 0, { jobStatus: "queued", createdAt: at(100 + i) }))
          .requestId,
      );
    }
    const dash = await getDashboard(handle(), { ownerId: USER_A });
    expect(dash.pending.map((i) => i.requestId)).toEqual(made.slice(2).reverse());
    expect(dash.running.map((i) => i.requestId)).toEqual(runningMade.slice(2).reverse());
  });

  it("counts every undecided draft in undecidedTotal, beyond the capped pending list", async () => {
    const c = await seedCurriculum(database.db);
    for (let i = 0; i < 7; i++) {
      await seedRequest(c, USER_A, 2, { createdAt: at(i) });
    }
    // Not counted: a request still running, another owner, and a decided (approved, current) question.
    await seedRequest(c, USER_A, 3, { jobStatus: "running", createdAt: at(50) });
    await seedRequest(c, USER_B, 4);
    const decided = await seedRequest(c, USER_A, 1, { createdAt: at(60) });
    await approve(decided.ids[0]);
    const dash = await getDashboard(handle(), { ownerId: USER_A });
    expect(dash.pending).toHaveLength(5);
    expect(dash.undecidedTotal).toBe(14);
  });

  it("counts the drafts of a request that has no job in undecidedTotal", async () => {
    const c = await seedCurriculum(database.db);
    const r = await seedRequest(c, USER_A, 2);
    await database.db
      .update(generationRequests)
      .set({ jobId: null })
      .where(eq(generationRequests.id, r.requestId));
    const dash = await getDashboard(handle(), { ownerId: USER_A });
    expect(dash.undecidedTotal).toBe(2);
  });

  it("counts an approval made stale by regeneration as undecided again", async () => {
    const c = await seedCurriculum(database.db);
    const r = await seedRequest(c, USER_A, 2);
    await approve(r.ids[0]);
    await approve(r.ids[1]);
    expect((await getDashboard(handle(), { ownerId: USER_A })).undecidedTotal).toBe(0);
    // Regenerating moves currentVersionId on; the status stays "approved" but the approval is stale.
    await regenerate(c, r.requestId, r.ids[0]);
    expect((await load(r.ids[0])).status).toBe("approved");
    const dash = await getDashboard(handle(), { ownerId: USER_A });
    expect(dash.undecidedTotal).toBe(1);
  });

  it("counts only banked, approved, current questions", async () => {
    const c = await seedCurriculum(database.db);
    const r = await seedRequest(c, USER_A, 4);
    await approve(r.ids[0]);
    await bank(r.ids[0]);
    // banked_at set but never approved: not counted.
    await bank(r.ids[1]);
    // approved and banked, then archived: not counted.
    await approve(r.ids[2]);
    await bank(r.ids[2]);
    await setStatus(r.ids[2], "archived");
    // approved and banked, then regenerated with the checks still pending: still counted (R19, the
    // bank shows the approved version meanwhile).
    await approve(r.ids[3]);
    await bank(r.ids[3]);
    await regenerate(c, r.requestId, r.ids[3]);
    await setStatus(r.ids[3], "approved");
    const dash = await getDashboard(handle(), { ownerId: USER_A });
    expect(dash.bankedCount).toBe(2);
  });

  it("returns no payload or error fields", async () => {
    const c = await seedCurriculum(database.db);
    const run = await seedRequest(c, USER_A, 0, { jobStatus: "running" });
    await database.db
      .update(jobs)
      .set({
        error: { code: "provider_busy", detail: "SECRET-ERROR" },
        progress: { step: "x", done: 0, total: 1, secret: "SECRET-PROGRESS" },
      })
      .where(eq(jobs.id, run.jobId));
    await seedRequest(c, USER_A, 1);
    const dash = await getDashboard(handle(), { ownerId: USER_A });
    expect(JSON.stringify(dash)).not.toMatch(
      /payload|error|correlation|attempts|lock|SECRET|groq|gpt-oss|stem|prompt/i,
    );
    expect(Object.keys(dash.running[0]).sort()).toEqual(
      [
        "createdAt",
        "jobStatus",
        "messageKey",
        "progress",
        "quantity",
        "requestId",
        "runAfter",
        "topicTitle",
      ].sort(),
    );
    expect(Object.keys(dash.pending[0]).sort()).toEqual(
      [
        "createdAt",
        "quantity",
        "readyToSave",
        "requestId",
        "topicTitle",
        "undecided",
      ].sort(),
    );
  });

  it("degrades on malformed params and progress", async () => {
    const c = await seedCurriculum(database.db);
    const bad = await seedRequest(c, USER_A, 0, {
      jobStatus: "running",
      params: { topicTitle: 42, quantity: "many" },
    });
    await database.db
      .update(jobs)
      .set({ progress: { done: "x", total: -1, messageKey: 7 } })
      .where(eq(jobs.id, bad.jobId));
    const nulls = await seedRequest(c, USER_A, 0, { jobStatus: "running", params: [] });
    await database.db
      .update(jobs)
      .set({ progress: [1, 2] })
      .where(eq(jobs.id, nulls.jobId));
    const over = await seedRequest(c, USER_A, 0, { jobStatus: "running" });
    await database.db
      .update(jobs)
      .set({ progress: { done: 5, total: 2, messageKey: "quota_minute" } })
      .where(eq(jobs.id, over.jobId));
    const pendingBad = await seedRequest(c, USER_A, 1, { params: "garbage" });
    const dash = await getDashboard(handle(), { ownerId: USER_A });
    const byId = new Map(dash.running.map((i) => [i.requestId, i]));
    expect(byId.get(bad.requestId)).toMatchObject({
      topicTitle: null,
      quantity: null,
      progress: null,
      messageKey: null,
    });
    expect(byId.get(nulls.requestId)).toMatchObject({
      topicTitle: null,
      quantity: null,
      progress: null,
    });
    expect(byId.get(over.requestId)).toMatchObject({
      progress: null,
      messageKey: "quota_minute",
    });
    expect(dash.pending.find((i) => i.requestId === pendingBad.requestId)).toMatchObject({
      topicTitle: null,
      quantity: null,
    });
  });

  it("works through runAsUser (RLS) and never leaks across users", async () => {
    const c = await seedCurriculum(database.db);
    const mine = await seedRequest(c, USER_A, 2);
    await approve(mine.ids[0]);
    await seedRequest(c, USER_B, 1);
    const dash = await runAsUser(database.db, USER_A, (tx) =>
      getDashboard(tx as unknown as AnyDb, { ownerId: USER_A }),
    );
    expect(dash.pending).toMatchObject([
      { requestId: mine.requestId, undecided: 1, readyToSave: 1 },
    ]);
    const crossed = await runAsUser(database.db, USER_B, (tx) =>
      getDashboard(tx as unknown as AnyDb, { ownerId: USER_A }),
    );
    expect(crossed).toEqual({
      hasActivity: false,
      running: [],
      pending: [],
      bankedCount: 0,
      undecidedTotal: 0,
    });
  });
});
