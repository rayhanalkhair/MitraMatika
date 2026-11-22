import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAsUser } from "@/lib/db/client";
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
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { persistDrafts, type AnyDb } from "./persist";
import { multipleChoiceQuestionSchema } from "../schema/schemas";
import { questionJson, seedCurriculum, seedGenerationRequest } from "./test-support";
import { getQuestionTrace, getRequestTraces } from "./trace";
import {
  insertRegenerationMarker,
  insertVerificationRun,
  persistRegeneratedVersion,
} from "./verify-persist";

let database: TestDatabase;
const NOW = new Date("2026-10-11T10:00:00.000Z");
const LATER = new Date("2026-10-11T10:05:00.000Z");
const db = () => database.db as unknown as AnyDb;

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await database.client.close();
});

async function resetAll() {
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
}

beforeEach(resetAll);

async function seedDrafts(count: number, owner = USER_A) {
  const c = await seedCurriculum(database.db);
  const { requestId } = await seedGenerationRequest(database.db, {
    ownerId: owner,
    ...c,
  });
  const saved = await database.db.transaction(async (tx) =>
    persistDrafts(tx as unknown as AnyDb, {
      ownerId: owner,
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
        usage: { inputTokens: 1200, outputTokens: 800, cachedTokens: 5 },
        latencyMs: 2100,
      },
      questions: Array.from({ length: count }, (_, i) =>
        multipleChoiceQuestionSchema.parse(questionJson(i + 1)),
      ),
      now: NOW,
    }),
  );
  return { c, requestId, questionIds: saved.questionIds };
}

const realRun = (
  versionId: string,
  status: Parameters<typeof insertVerificationRun>[1]["status"],
  at = LATER,
  extra = {},
) =>
  insertVerificationRun(db(), {
    ownerId: USER_A,
    versionId,
    verifierVersion: "p1-12.1",
    status,
    checks: [{ type: "numeric_eval", status: "pass", detail: "1+1 = 2" }],
    crossCheck: { provider: "groq", model: "openai/gpt-oss-20b", verdict: "agree" },
    now: at,
    ...extra,
  });

describe("getQuestionTrace", () => {
  it("returns the full provenance of a generated, verified question", async () => {
    const { c, questionIds } = await seedDrafts(1);
    const first = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });
    await realRun(first!.versionId, "terverifikasi");

    const trace = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });

    expect(trace).toMatchObject({
      questionId: questionIds[0],
      versionNo: 1,
      changeKind: "generated",
      author: "ai",
      generation: {
        provider: "groq",
        model: "openai/gpt-oss-120b",
        promptVersion: "generate-mc.id@1",
        curriculumVersionId: c.versionId,
        latencyMs: 2100,
        tokens: { input: 1200, output: 800, cached: 5 },
      },
      curriculum: {
        versionCode: "v1",
        topicId: c.topicId,
        topicStableKey: "spldv",
        topicTitle: "SPLDV",
        element: { code: "aljabar", name: "Aljabar" },
        objectives: [{ code: "TP-3", text: "Tiga" }],
        sourceAnchor: c.sourceRef,
      },
      verification: {
        status: "terverifikasi",
        verifierVersion: "p1-12.1",
        regenerationFailed: false,
        checks: [{ type: "numeric_eval", status: "pass", detail: "1+1 = 2" }],
        crossCheck: { provider: "groq", model: "openai/gpt-oss-20b", verdict: "agree" },
      },
      versions: [{ versionNo: 1, changeKind: "generated", status: "terverifikasi" }],
    });
    expect(trace!.generation!.ranAt).toEqual(NOW);
    expect(trace!.verification.verifiedAt).toEqual(LATER);
    // No prompt or provider response leaves the module.
    expect(JSON.stringify(trace)).not.toMatch(/prompt":|"response"/);
  });

  it("shows the placeholder status before any run exists", async () => {
    const { questionIds } = await seedDrafts(1);
    const trace = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });
    expect(trace!.verification).toEqual({
      status: "belum_dapat_diverifikasi",
      verifierVersion: null,
      verifiedAt: null,
      checks: [],
      crossCheck: null,
      regenerationFailed: false,
    });
  });

  it("returns the cross-checked status in the domain spelling", async () => {
    const { questionIds } = await seedDrafts(1);
    const base = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });
    await realRun(base!.versionId, "dicek_silang");

    const [raw] = await database.db.select().from(verificationRuns);
    expect(raw.status).toBe("dicek_silang_ai");
    const trace = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });
    expect(trace!.verification.status).toBe("dicek_silang");
    expect(trace!.versions[0].status).toBe("dicek_silang");
  });

  it("uses the latest real run", async () => {
    const { questionIds } = await seedDrafts(1);
    const base = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });
    await realRun(base!.versionId, "belum_dapat_diverifikasi", NOW);
    await realRun(base!.versionId, "terverifikasi", LATER);
    const trace = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });
    expect(trace!.verification.status).toBe("terverifikasi");
    expect(trace!.verification.verifiedAt).toEqual(LATER);
  });

  it("does not mistake a regeneration marker for a run", async () => {
    const { questionIds } = await seedDrafts(1);
    const base = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });
    await realRun(base!.versionId, "terverifikasi", NOW);
    await insertRegenerationMarker(db(), {
      ownerId: USER_A,
      versionId: base!.versionId,
      now: LATER,
    });

    const trace = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });

    expect(trace!.verification).toMatchObject({
      status: "terverifikasi",
      verifiedAt: NOW,
      regenerationFailed: true,
    });
  });

  it("returns the current version and the lineage of a regenerated question", async () => {
    const { c, requestId, questionIds } = await seedDrafts(1);
    const v1 = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });
    await realRun(v1!.versionId, "ketidaksesuaian", NOW);
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
          model: "openai/gpt-oss-120b",
          promptVersion: "generate-mc.id@1",
          curriculumVersionId: c.versionId,
          usage: { inputTokens: 90, outputTokens: 60 },
          latencyMs: 700,
        },
        question: multipleChoiceQuestionSchema.parse(questionJson(9)),
        now: LATER,
      }),
    );
    const v2 = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });
    await realRun(v2!.versionId, "terverifikasi", LATER);

    const current = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });
    const original = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
      versionNo: 1,
    });

    expect(current).toMatchObject({
      versionNo: 2,
      changeKind: "regenerated",
      verification: { status: "terverifikasi" },
      generation: { latencyMs: 700, tokens: { input: 90, output: 60 } },
    });
    expect(original).toMatchObject({
      versionNo: 1,
      changeKind: "generated",
      verification: { status: "ketidaksesuaian" },
    });
    expect(current!.versions).toEqual([
      { versionNo: 1, changeKind: "generated", status: "ketidaksesuaian" },
      { versionNo: 2, changeKind: "regenerated", status: "terverifikasi" },
    ]);
  });

  it("falls back to no checks for an unexpected stored shape", async () => {
    const { questionIds } = await seedDrafts(1);
    const base = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });
    await realRun(base!.versionId, "terverifikasi", NOW, {
      checks: { not: "an array" },
      crossCheck: { verdict: 7 },
    });
    const trace = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });
    expect(trace!.verification.checks).toEqual([]);
    expect(trace!.verification.crossCheck).toBeNull();
    expect(trace!.verification.status).toBe("terverifikasi");
  });

  it("returns null for another owner's question and for an unknown id", async () => {
    const { questionIds } = await seedDrafts(1);
    expect(
      await getQuestionTrace(db(), { ownerId: USER_B, questionId: questionIds[0] }),
    ).toBeNull();
    expect(
      await getQuestionTrace(db(), {
        ownerId: USER_A,
        questionId: "99999999-9999-4999-8999-999999999999",
      }),
    ).toBeNull();
    expect(
      await getQuestionTrace(db(), {
        ownerId: USER_A,
        questionId: questionIds[0],
        versionNo: 7,
      }),
    ).toBeNull();
  });

  it("works under row-level security", async () => {
    const { c, requestId, questionIds } = await seedDrafts(1);
    const base = await getQuestionTrace(db(), {
      ownerId: USER_A,
      questionId: questionIds[0],
    });
    await realRun(base!.versionId, "terverifikasi");

    const asOwner = await runAsUser(database.db, USER_A, (tx) =>
      getQuestionTrace(tx as unknown as AnyDb, {
        ownerId: USER_A,
        questionId: questionIds[0],
      }),
    );
    const asOther = await runAsUser(database.db, USER_B, (tx) =>
      getQuestionTrace(tx as unknown as AnyDb, {
        ownerId: USER_A,
        questionId: questionIds[0],
      }),
    );

    expect(asOwner).toMatchObject({
      verification: { status: "terverifikasi" },
      generation: { provider: "groq", promptVersion: "generate-mc.id@1" },
      curriculum: {
        versionCode: "v1",
        topicStableKey: "spldv",
        sourceAnchor: c.sourceRef,
      },
    });
    expect(asOther).toBeNull();

    const batchAsOwner = await runAsUser(database.db, USER_A, (tx) =>
      getRequestTraces(tx as unknown as AnyDb, { ownerId: USER_A, requestId }),
    );
    const batchAsOther = await runAsUser(database.db, USER_B, (tx) =>
      getRequestTraces(tx as unknown as AnyDb, { ownerId: USER_A, requestId }),
    );
    expect(batchAsOwner).toHaveLength(1);
    expect(batchAsOwner[0].generation).not.toBeNull();
    expect(batchAsOwner[0].curriculum).not.toBeNull();
    expect(batchAsOther).toEqual([]);
  });
});

describe("getRequestTraces", () => {
  it("returns the owner's questions of the request in a stable order", async () => {
    const { requestId, questionIds } = await seedDrafts(3);
    const traces = await getRequestTraces(db(), { ownerId: USER_A, requestId });
    const again = await getRequestTraces(db(), { ownerId: USER_A, requestId });
    expect(again.map((t) => t.questionId)).toEqual(traces.map((t) => t.questionId));
    expect(traces).toHaveLength(3);
    expect(new Set(traces.map((t) => t.questionId))).toEqual(new Set(questionIds));
    expect(traces.every((t) => t.versionNo === 1)).toBe(true);
  });

  it("returns nothing for another owner", async () => {
    const { requestId } = await seedDrafts(2);
    expect(await getRequestTraces(db(), { ownerId: USER_B, requestId })).toEqual([]);
  });

  it("uses the same number of statements whatever the batch size", async () => {
    const spy = vi.spyOn(database.client, "query");
    const countFor = async (count: number) => {
      const { requestId } = await seedDrafts(count);
      spy.mockClear();
      await getRequestTraces(db(), { ownerId: USER_A, requestId });
      return spy.mock.calls.length;
    };
    const one = await countFor(1);
    await resetAll();
    const five = await countFor(5);
    spy.mockRestore();

    // Guard against a spy that sees nothing: the loader does run statements.
    expect(one).toBeGreaterThan(0);
    expect(five).toBe(one);
  });
});
