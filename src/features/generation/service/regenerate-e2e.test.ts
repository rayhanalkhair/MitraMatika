import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createRuntimeGateway } from "@/lib/ai/runtime";
import { resetE2eAi, setScenario } from "@/lib/ai/e2e/control";
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
  usageEvents,
  verificationRuns,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { getBankQuestion } from "@/features/bank";
import type { AnyDb } from "./persist";
import { createGenerateBatchHandler } from "./generate-batch";
import { createRegenerateQuestionHandler, requestRegeneration } from "./regenerate";
import { buildContext, seedCurriculum, seedGenerationRequest } from "./test-support";

// The bank e2e (tests/e2e/bank.spec.ts, "regenerate with the fake provider") end to end below the
// browser: the REAL generate_batch and regenerate_question handlers with the gateway built by
// createRuntimeGateway while the e2e scripted AI is on. The regenerated version must verify as
// sound, so the banked question stays banked and the detail shows the compare (step "saved").

let database: TestDatabase;
const NOW = new Date("2026-10-11T10:00:00.000Z");
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
  await d.delete(usageEvents);
  await d.delete(auditLog);
  await d.delete(generationRequests);
  await d.delete(jobs);
  await d.delete(learningObjectives);
  await d.delete(topics);
  await d.delete(cpElements);
  await d.delete(curriculumVersions);
  vi.stubEnv("E2E_FAKE_AI", "1");
  vi.stubEnv("NODE_ENV", "development");
  resetE2eAi();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetE2eAi();
});

describe("regenerate with the e2e scripted AI", () => {
  it(
    "keeps a banked question banked on a verified new version (the compare's 'saved' step)",
    async () => {
      setScenario("valid");
      const c = await seedCurriculum(database.db);
      const seeded = await seedGenerationRequest(database.db, {
        ownerId: USER_A,
        quantity: 1,
        ...c,
      });
      const generated = await createGenerateBatchHandler({
        db: database.db,
        createGateway: (budget) => createRuntimeGateway(budget),
        now: () => NOW,
      })(await buildContext(database.db, seeded.jobId, { now: NOW }));
      expect(generated.kind).toBe("done");
      await database.db
        .update(jobs)
        .set({ status: "succeeded" })
        .where(eq(jobs.id, seeded.jobId));
      const [question] = await database.db.select().from(questions);
      await database.db
        .update(questions)
        .set({
          status: "approved",
          approvedVersionId: question.currentVersionId,
          approvedAt: NOW,
          bankedAt: NOW,
        })
        .where(eq(questions.id, question.id));

      const queued = await requestRegeneration(db(), {
        ownerId: USER_A,
        questionId: question.id,
        hint: null,
        now: NOW,
      });
      if (!queued.ok) throw new Error(`refused: ${queued.error.reason}`);
      const result = await createRegenerateQuestionHandler({
        db: db(),
        createGateway: (budget) => createRuntimeGateway(budget),
        now: () => NOW,
      })(await buildContext(database.db, queued.data.jobId, { now: NOW }));

      expect(result).toMatchObject({ kind: "done", progress: { step: "saved" } });
      const after = (
        await database.db.select().from(questions).where(eq(questions.id, question.id))
      )[0];
      expect(after.status).toBe("approved");
      expect(after.bankedAt).not.toBeNull();
      expect(after.currentVersionId).not.toBe(question.currentVersionId);
      expect(after.approvedVersionId).toBe(after.currentVersionId);
      const versions = await database.db
        .select()
        .from(questionVersions)
        .where(eq(questionVersions.questionId, question.id));
      expect(versions.map((v) => v.changeKind).sort()).toEqual([
        "generated",
        "regenerated",
      ]);
      const detail = await getBankQuestion(db(), {
        ownerId: USER_A,
        questionId: question.id,
      });
      expect(detail?.question.versionId).toBe(after.currentVersionId);
      expect(detail?.question.verification.status).toBe("terverifikasi");
    },
    DB_TEST_TIMEOUT,
  );
});
