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
import { persistDrafts, type AnyDb } from "./persist";
import { GENERATE_QUOTA, SOLVE_QUOTA } from "./quota";
import { multipleChoiceQuestionSchema } from "../schema/schemas";
import { questionJson, seedCurriculum, seedGenerationRequest } from "./test-support";
import { correctionNoteFrom, verifyRequest, type VerifyInput } from "./verify-batch";

let database: TestDatabase;
const NOW = new Date("2026-10-11T10:00:00.000Z");
const DEADLINE = NOW.getTime() + 240_000;

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

const solver = (label: string, machine: string) =>
  JSON.stringify({
    correctLabel: label,
    answer: { display_md: machine, machine },
    steps: ["Selesaikan soalnya."],
  });

const batchOf = (items: unknown[]) => JSON.stringify({ questions: items });
const failingClaim = (n: number) => ({
  ...questionJson(n),
  verification_claims: [
    { type: "numeric_eval", expression: `${String(n)}+${String(n)}`, expected: "99" },
  ],
});
const unsupportedClaim = (n: number) => ({
  ...questionJson(n),
  verification_claims: [
    { type: "numeric_eval", expression: `${String(n)}+${String(n)}`, expected: "dua" },
  ],
});

async function seed(items: unknown[], quantity = items.length) {
  const c = await seedCurriculum(database.db);
  const { requestId, jobId } = await seedGenerationRequest(database.db, {
    ownerId: USER_A,
    quantity,
    ...c,
  });
  await database.db.transaction(async (tx) =>
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
        usage: { inputTokens: 100, outputTokens: 50 },
        latencyMs: 10,
      },
      questions: items.map((item) => multipleChoiceQuestionSchema.parse(item)),
      now: NOW,
    }),
  );
  return { c, requestId, jobId };
}

function setup(responses: (string | Error)[], remainingDeadline = DEADLINE) {
  const provider = createFakeProvider("groq", responses);
  const deps = {
    db: database.db as unknown as AnyDb,
    createGateway: (budget: Parameters<typeof createGateway>[0]["budget"]) =>
      createGateway({ routing: defaultRouting, providers: { groq: provider }, budget }),
    now: () => NOW,
  };
  const input = (seeded: Awaited<ReturnType<typeof seed>>): Promise<VerifyInput> =>
    Promise.resolve({
      ownerId: USER_A,
      jobId: seeded.jobId,
      requestId: seeded.requestId,
      deadline: remainingDeadline,
      loadContext: () =>
        Promise.resolve({
          topicId: seeded.c.topicId,
          sourceRef: seeded.c.sourceRef,
          curriculumVersionId: seeded.c.versionId,
          pack: {
            grade: 8,
            topicTitle: "SPLDV",
            topicScopeNotes: "Catatan spldv",
            objectives: [{ code: "TP-3", text: "Tiga" }],
            difficulty: "sedang",
            count: 1,
            dataClass: "C0",
          },
        }),
    });
  return { provider, deps, input };
}

// question_versions is immutable, so a version's status is that of its latest real run
// (regeneration markers are not runs); the column only holds the creation value.
// crossCheck is jsonb: `in` needs an object, which a truthiness check does not narrow to.
function hasRegeneration(crossCheck: unknown): boolean {
  return (
    typeof crossCheck === "object" && crossCheck !== null && "regeneration" in crossCheck
  );
}

async function effectiveStatus(versionId: string): Promise<string> {
  const runs = await database.db
    .select()
    .from(verificationRuns)
    .where(eq(verificationRuns.questionVersionId, versionId))
    .orderBy(asc(verificationRuns.createdAt), asc(verificationRuns.id));
  const real = runs.filter(
    (run) =>
      !(
        typeof run.crossCheck === "object" &&
        run.crossCheck !== null &&
        "regeneration" in (run.crossCheck as Record<string, unknown>)
      ),
  );
  const latest = real.at(-1);
  // The DB check constraint spells the cross-checked status `dicek_silang_ai`.
  const app = (status: string) =>
    status === "dicek_silang_ai" ? "dicek_silang" : status;
  if (latest) return app(latest.status);
  const [row] = await database.db
    .select()
    .from(questionVersions)
    .where(eq(questionVersions.id, versionId));
  return app(row.verificationStatus);
}

async function versionsOf(questionNo = 0) {
  const qs = await database.db.select().from(questions);
  const q = qs[questionNo];
  const versions = await database.db
    .select()
    .from(questionVersions)
    .where(eq(questionVersions.questionId, q.id));
  return { q, versions: versions.sort((a, b) => a.versionNo - b.versionNo) };
}

describe("verifyRequest", () => {
  it("marks a question terverifikasi when its claims pass and the solver agrees", async () => {
    const seeded = await seed([questionJson(1)]);
    const { deps, input, provider } = setup([solver("B", "2")]);

    const outcome = await verifyRequest(deps, await input(seeded));

    expect(outcome).toMatchObject({
      kind: "done",
      regenerated: 0,
      counts: {
        terverifikasi: 1,
        dicek_silang: 0,
        belum_dapat_diverifikasi: 0,
        ketidaksesuaian: 0,
      },
    });
    const { versions } = await versionsOf();
    expect(await effectiveStatus(versions[0].id)).toBe("terverifikasi");
    const [run] = await database.db.select().from(verificationRuns);
    expect(run).toMatchObject({
      ownerId: USER_A,
      verifierVersion: "p1-12.1",
      status: "terverifikasi",
      crossCheck: { provider: "groq", model: SOLVE_QUOTA.model, verdict: "agree" },
    });
    expect(run.checks).toEqual([
      { type: "numeric_eval", status: "pass", detail: expect.any(String) as unknown },
    ]);
    const [call] = await database.db.select().from(aiCalls);
    expect(call).toMatchObject({
      ownerId: USER_A,
      jobId: seeded.jobId,
      task: "solve_independent",
      model: SOLVE_QUOTA.model,
      promptVersion: "solve-independent.id@1",
      outcome: "ok",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(provider.calls).toHaveLength(1);
    // The key is never sent to the solver.
    expect(provider.calls[0].prompt).not.toMatch(/correctLabel": "B"/);
  });

  it("marks dicek_silang when no claim passes and the solver agrees", async () => {
    const seeded = await seed([unsupportedClaim(1)]);
    const { deps, input } = setup([solver("B", "2")]);
    await verifyRequest(deps, await input(seeded));
    const { versions } = await versionsOf();
    expect(await effectiveStatus(versions[0].id)).toBe("dicek_silang");
  });

  it("uses the claims alone when the cross-check is unusable", async () => {
    const seeded = await seed([unsupportedClaim(1)]);
    // No queued response: the fake provider throws, like a provider outage.
    const { deps, input } = setup([]);

    const outcome = await verifyRequest(deps, await input(seeded));

    expect(outcome.kind).toBe("done");
    const { versions } = await versionsOf();
    expect(await effectiveStatus(versions[0].id)).toBe("belum_dapat_diverifikasi");
    const [run] = await database.db.select().from(verificationRuns);
    expect(run.crossCheck).toMatchObject({ verdict: "unknown" });
    const calls = await database.db.select().from(aiCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ task: "solve_independent", outcome: "error" });
  });

  it("keeps terverifikasi from the claims when the cross-check is unusable", async () => {
    const seeded = await seed([questionJson(1)]);
    const { deps, input } = setup([]);
    await verifyRequest(deps, await input(seeded));
    const { versions } = await versionsOf();
    expect(await effectiveStatus(versions[0].id)).toBe("terverifikasi");
  });

  it("regenerates a contradicted question once and verifies version 2", async () => {
    const seeded = await seed([failingClaim(1)]);
    const { deps, input, provider } = setup([
      solver("B", "2"), // cross-check of version 1 (claims fail anyway)
      batchOf([questionJson(5)]), // regeneration
      solver("B", "10"), // cross-check of version 2
    ]);

    const outcome = await verifyRequest(deps, await input(seeded));

    expect(outcome).toMatchObject({
      kind: "done",
      regenerated: 1,
      counts: { terverifikasi: 1, ketidaksesuaian: 0 },
    });
    const { q, versions } = await versionsOf();
    const tuples = await Promise.all(
      versions.map(async (v) => [v.versionNo, await effectiveStatus(v.id), v.changeKind]),
    );
    expect(tuples).toEqual([
      [1, "ketidaksesuaian", "generated"],
      [2, "terverifikasi", "regenerated"],
    ]);
    expect(q.currentVersionId).toBe(versions[1].id);
    expect(await database.db.select().from(generationRuns)).toHaveLength(2);
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[1].prompt).toContain("Catatan perbaikan");
    expect(provider.calls[1].prompt).toContain("1+1");
    const tasks = (await database.db.select().from(aiCalls)).map((c) => c.task).sort();
    expect(tasks).toEqual([
      "generate_questions",
      "solve_independent",
      "solve_independent",
    ]);
  });

  it("regenerates when the solver disagrees although the claims pass", async () => {
    const seeded = await seed([questionJson(1)]);
    const { deps, input, provider } = setup([
      solver("A", "1"),
      batchOf([questionJson(5)]),
      solver("B", "10"),
    ]);

    await verifyRequest(deps, await input(seeded));

    const { versions } = await versionsOf();
    expect(await Promise.all(versions.map((v) => effectiveStatus(v.id)))).toEqual([
      "ketidaksesuaian",
      "terverifikasi",
    ]);
    expect(provider.calls[1].prompt).toContain("jawaban berbeda");
  });

  it("never regenerates a second time", async () => {
    const seeded = await seed([failingClaim(1)]);
    const { deps, input, provider } = setup([
      solver("B", "2"),
      batchOf([failingClaim(5)]), // regeneration also contradicts
      solver("B", "10"),
    ]);

    const outcome = await verifyRequest(deps, await input(seeded));

    expect(outcome).toMatchObject({ kind: "done", regenerated: 1 });
    const { versions } = await versionsOf();
    expect(versions).toHaveLength(2);
    expect(await effectiveStatus(versions[1].id)).toBe("ketidaksesuaian");
    expect(provider.calls).toHaveLength(3);

    // A re-run does nothing more.
    const again = setup([]);
    const second = await verifyRequest(again.deps, await again.input(seeded));
    expect(second.kind).toBe("done");
    expect(again.provider.calls).toHaveLength(0);
    expect((await versionsOf()).versions).toHaveLength(2);
  });

  it("keeps version 1 when the regeneration fails the structural checks", async () => {
    const seeded = await seed([failingClaim(1)]);
    const duplicate = {
      ...questionJson(5),
      options: [
        { label: "A", text_md: "5" },
        { label: "B", text_md: "0,5" },
        { label: "C", text_md: "1/2" },
        { label: "D", text_md: "7" },
      ],
      correctLabel: "B",
      answer: { display_md: "0,5", machine: "0,5" },
    };
    const { deps, input } = setup([solver("B", "2"), batchOf([duplicate])]);

    const outcome = await verifyRequest(deps, await input(seeded));

    expect(outcome).toMatchObject({
      kind: "done",
      regenerated: 0,
      counts: { ketidaksesuaian: 1 },
    });
    const { q, versions } = await versionsOf();
    expect(versions).toHaveLength(1);
    expect(q.currentVersionId).toBe(versions[0].id);
    const calls = await database.db.select().from(aiCalls);
    const regen = calls.find((c) => c.task === "generate_questions");
    expect(regen).toMatchObject({ outcome: "ok", inputTokens: 100, outputTokens: 50 });
  });

  it("records a failed regeneration so a re-run does not retry it", async () => {
    const seeded = await seed([failingClaim(1)]);
    // The regeneration call fails (no queued response after the cross-check).
    const first = setup([solver("B", "2")]);
    await verifyRequest(first.deps, await first.input(seeded));

    const again = setup([batchOf([questionJson(5)])]);
    const second = await verifyRequest(again.deps, await again.input(seeded));

    expect(second).toMatchObject({ kind: "done", regenerated: 0 });
    expect(again.provider.calls).toHaveLength(0);
    expect((await versionsOf()).versions).toHaveLength(1);
  });

  it("defers when the cross-check budget is exhausted", async () => {
    const seeded = await seed([questionJson(1), questionJson(2)]);
    await database.db.insert(aiCalls).values({
      ownerId: USER_B,
      task: "solve_independent",
      provider: "groq",
      model: SOLVE_QUOTA.model,
      promptVersion: "solve-independent.id@1",
      inputTokens: 7_500,
      outputTokens: 0,
      outcome: "ok",
      createdAt: new Date(NOW.getTime() - 20_000),
    });
    const { deps, input, provider } = setup([solver("B", "2"), solver("B", "4")]);

    const outcome = await verifyRequest(deps, await input(seeded));

    expect(outcome).toEqual({
      kind: "defer",
      runAfter: new Date(NOW.getTime() + 60_000),
      reason: "quota_minute",
    });
    expect(provider.calls).toHaveLength(0);
    expect(await database.db.select().from(verificationRuns)).toHaveLength(0);
  });

  const SPENT_AT = new Date(NOW.getTime() - 3_600_000);
  const GENERATION_RESUME = new Date(SPENT_AT.getTime() + 86_400_000);
  const exhaustGenerationBudget = () =>
    database.db.insert(aiCalls).values({
      ownerId: USER_B,
      task: "generate_questions",
      provider: "groq",
      model: GENERATE_QUOTA.model,
      promptVersion: "generate-mc.id@1",
      // The per-minute bucket cannot be used here: a C0 request falls back to the next route, so the
      // daily plan is what refuses the regeneration (it resumes when the spend ages out).
      inputTokens: 199_000,
      outputTokens: 0,
      outcome: "ok",
      createdAt: SPENT_AT,
    });

  it("cross-checks every pending version before a regeneration waits for its budget", async () => {
    // Processing order is by id (random): the failing question may come first or second.
    const seeded = await seed([failingClaim(1), questionJson(2)]);
    await exhaustGenerationBudget();
    const { deps, input, provider } = setup([solver("B", "2"), solver("B", "2")]);

    const outcome = await verifyRequest(deps, await input(seeded));

    expect(outcome).toEqual({
      kind: "defer",
      runAfter: GENERATION_RESUME,
      reason: "quota_daily",
    });
    expect(provider.calls).toHaveLength(2);
    const runs = await database.db.select().from(verificationRuns);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.crossCheck && !hasRegeneration(run.crossCheck))).toBe(
      true,
    );
    const versions = await database.db.select().from(questionVersions);
    expect(versions).toHaveLength(2);
    const statuses = (
      await Promise.all(versions.map((v) => effectiveStatus(v.id)))
    ).sort();
    expect(statuses).toEqual(["ketidaksesuaian", "terverifikasi"]);
  });

  it("defers a regeneration on the generation budget and resumes it exactly once", async () => {
    const seeded = await seed([failingClaim(1)]);
    await exhaustGenerationBudget();
    const first = setup([solver("B", "2")]);

    const outcome = await verifyRequest(first.deps, await first.input(seeded));

    expect(outcome).toEqual({
      kind: "defer",
      runAfter: GENERATION_RESUME,
      reason: "quota_daily",
    });
    expect(first.provider.calls).toHaveLength(1);
    const runs = await database.db.select().from(verificationRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("ketidaksesuaian");
    expect((await versionsOf()).versions).toHaveLength(1);
    const generateCalls = (await database.db.select().from(aiCalls)).filter(
      (call) => call.task === "generate_questions" && call.ownerId === USER_A,
    );
    expect(
      generateCalls.every(
        (call) => (call.inputTokens ?? 0) + (call.outputTokens ?? 0) === 0,
      ),
    ).toBe(true);

    await database.db.delete(aiCalls).where(eq(aiCalls.ownerId, USER_B));
    const second = setup([batchOf([questionJson(5)]), solver("B", "10")]);
    const resumed = await verifyRequest(second.deps, await second.input(seeded));

    expect(resumed).toMatchObject({
      kind: "done",
      regenerated: 1,
      counts: { terverifikasi: 1, ketidaksesuaian: 0 },
    });
    expect(second.provider.calls).toHaveLength(2);
    const { versions } = await versionsOf();
    expect(versions).toHaveLength(2);
    expect(await effectiveStatus(versions[1].id)).toBe("terverifikasi");
    const markers = (await database.db.select().from(verificationRuns)).filter(
      (run) => run.crossCheck && hasRegeneration(run.crossCheck),
    );
    expect(markers).toHaveLength(0);
  });

  it("uses the first replacement that passes the structural checks", async () => {
    const seeded = await seed([failingClaim(1)]);
    const duplicate = {
      ...questionJson(5),
      options: [
        { label: "A", text_md: "5" },
        { label: "B", text_md: "0,5" },
        { label: "C", text_md: "1/2" },
        { label: "D", text_md: "7" },
      ],
      correctLabel: "B",
      answer: { display_md: "0,5", machine: "0,5" },
    };
    const valid = questionJson(6);
    const { deps, input } = setup([
      solver("B", "2"),
      batchOf([duplicate, valid]),
      solver("B", "12"),
    ]);

    const outcome = await verifyRequest(deps, await input(seeded));

    expect(outcome).toMatchObject({ kind: "done", regenerated: 1 });
    const { q, versions } = await versionsOf();
    expect(versions).toHaveLength(2);
    expect(q.currentVersionId).toBe(versions[1].id);
    expect(versions[1].stemMd).toBe(valid.stem_md);
    const regen = (await database.db.select().from(aiCalls)).filter(
      (call) => call.task === "generate_questions",
    );
    expect(regen).toHaveLength(1);
    expect(regen[0]).toMatchObject({ outcome: "ok", inputTokens: 100, outputTokens: 50 });
  });

  it("resumes without verifying twice", async () => {
    const seeded = await seed([questionJson(1), questionJson(2), questionJson(3)]);
    // Deterministic stop: 95 s left passes the 90 s guard for the first version; the clock then
    // moves 10 s after the first model call, so the guard of the next iteration defers.
    const first = setup([solver("B", "2")]);
    const firstInput = await first.input(seeded);
    const clocked = {
      ...first.deps,
      now: () =>
        first.provider.calls.length > 0 ? new Date(NOW.getTime() + 10_000) : NOW,
    };
    const run1 = await verifyRequest(clocked, {
      ...firstInput,
      deadline: NOW.getTime() + 95_000,
    });
    expect(run1).toEqual({
      kind: "defer",
      runAfter: new Date(NOW.getTime() + 95_000),
      reason: "time",
    });

    const runs = await database.db.select().from(verificationRuns);
    expect(runs).toHaveLength(1);
    const verifiedIds = new Set(runs.map((r) => r.questionVersionId));

    const second = setup([solver("B", "2"), solver("B", "4"), solver("B", "6")]);
    const outcome = await verifyRequest(second.deps, await second.input(seeded));

    expect(outcome.kind).toBe("done");
    const all = await database.db.select().from(verificationRuns);
    expect(all).toHaveLength(3);
    expect(new Set(all.map((r) => r.questionVersionId)).size).toBe(3);
    // Versions verified by the first run were not sent to the solver again.
    expect(second.provider.calls).toHaveLength(3 - verifiedIds.size);
  });

  it("makes no model call when everything is already verified", async () => {
    const seeded = await seed([questionJson(1)]);
    const first = setup([solver("B", "2")]);
    await verifyRequest(first.deps, await first.input(seeded));

    const again = setup([]);
    const outcome = await verifyRequest(again.deps, await again.input(seeded));

    expect(outcome.kind).toBe("done");
    expect(again.provider.calls).toHaveLength(0);
    expect(await database.db.select().from(verificationRuns)).toHaveLength(1);
  });

  it("defers before a model call when little runner time is left", async () => {
    const seeded = await seed([questionJson(1)]);
    const { deps, input, provider } = setup([solver("B", "2")], NOW.getTime() + 60_000);

    const outcome = await verifyRequest(deps, await input(seeded));

    expect(outcome).toEqual({
      kind: "defer",
      runAfter: new Date(NOW.getTime() + 60_000),
      reason: "time",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("scopes every write to the owner", async () => {
    const seeded = await seed([failingClaim(1)]);
    const { deps, input } = setup([
      solver("B", "2"),
      batchOf([questionJson(5)]),
      solver("B", "10"),
    ]);
    await verifyRequest(deps, await input(seeded));

    for (const table of [verificationRuns, aiCalls, generationRuns, questionVersions]) {
      const rows = (await database.db.select().from(table)) as { ownerId: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.ownerId === USER_A)).toBe(true);
    }
  });

  it("emits the regeneration audit once, with the reason", async () => {
    const seeded = await seed([failingClaim(1)]);
    const { deps, input } = setup([
      solver("B", "2"),
      batchOf([questionJson(5)]),
      solver("B", "10"),
    ]);

    await verifyRequest(deps, await input(seeded));

    const rows = await database.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId: USER_A,
      action: "question_regenerated",
      entityType: "question",
      metadata: { versionNo: 2, reason: "claim_failed" },
    });
    expect(JSON.stringify(rows[0].metadata)).not.toContain("Hitung");

    // A re-run sees version 2 and emits nothing more.
    const again = setup([]);
    await verifyRequest(again.deps, await again.input(seeded));
    expect(await database.db.select().from(auditLog)).toHaveLength(1);
  });

  it("names a solver disagreement as the reason", async () => {
    const seeded = await seed([questionJson(1)]);
    const { deps, input } = setup([
      solver("A", "1"),
      batchOf([questionJson(5)]),
      solver("B", "10"),
    ]);
    await verifyRequest(deps, await input(seeded));
    const [row] = await database.db.select().from(auditLog);
    expect(row.metadata).toMatchObject({ reason: "cross_check_disagreed" });
  });

  it("emits no regeneration audit when the regeneration was not usable", async () => {
    const seeded = await seed([failingClaim(1)]);
    const first = setup([solver("B", "2")]); // the regeneration call finds no response
    await verifyRequest(first.deps, await first.input(seeded));
    expect(await database.db.select().from(auditLog)).toHaveLength(0);
  });
  const limited = (retryAfterMs?: number) =>
    new AiProviderError("rate_limited", "Layanan AI sedang membatasi permintaan.", {
      status: 429,
      retryAfterMs,
    });

  it("defers a cross-check 429 and verifies on resume", async () => {
    const seeded = await seed([questionJson(1)]);
    const first = setup([limited(90_000)]);

    const outcome = await verifyRequest(first.deps, await first.input(seeded));

    expect(outcome).toEqual({
      kind: "defer",
      runAfter: new Date(NOW.getTime() + 90_000),
      reason: "provider",
    });
    expect(await database.db.select().from(verificationRuns)).toHaveLength(0);
    const [call] = await database.db.select().from(aiCalls);
    expect(call).toMatchObject({
      task: "solve_independent",
      outcome: "error",
      errorCode: "provider_rate_limited",
    });

    const second = setup([solver("B", "2")]);
    const done = await verifyRequest(second.deps, await second.input(seeded));
    expect(done.kind).toBe("done");
    expect(await database.db.select().from(verificationRuns)).toHaveLength(1);
  });

  it("treats a cross-check 429 past the cap as no signal", async () => {
    const seeded = await seed([questionJson(1)]);
    for (let i = 0; i < 5; i += 1) {
      await database.db.insert(aiCalls).values({
        ownerId: USER_A,
        jobId: seeded.jobId,
        task: "solve_independent",
        provider: "groq",
        model: SOLVE_QUOTA.model,
        promptVersion: "solve-independent.id@1",
        inputTokens: 0,
        outputTokens: 0,
        outcome: "error",
        errorCode: "provider_rate_limited",
        createdAt: new Date(NOW.getTime() - (i + 2) * 3_600_000 * 30),
      });
    }
    const { deps, input } = setup([limited()]);

    const outcome = await verifyRequest(deps, await input(seeded));

    expect(outcome.kind).toBe("done");
    const [run] = await database.db.select().from(verificationRuns);
    expect(run.crossCheck).toMatchObject({ verdict: "unknown", reason: "unavailable" });
    const calls = await database.db.select().from(aiCalls);
    const forJob = calls.filter((call) => call.jobId === seeded.jobId);
    expect(
      forJob.filter((call) => call.errorCode === "provider_rate_limited"),
    ).toHaveLength(5);
    expect(forJob.filter((call) => call.errorCode === "provider_busy")).toHaveLength(1);
    expect(calls.filter((call) => call.errorCode === "cross_check_failed")).toHaveLength(
      0,
    );
    const { versions } = await versionsOf();
    expect(await effectiveStatus(versions[0].id)).toBe("terverifikasi");
  });

  it("defers a cross-check daily refusal as quota_daily", async () => {
    const seeded = await seed([questionJson(1)]);
    const spentAt = new Date(NOW.getTime() - 3_600_000);
    await database.db.insert(aiCalls).values({
      ownerId: USER_B,
      task: "solve_independent",
      provider: "groq",
      model: SOLVE_QUOTA.model,
      promptVersion: "solve-independent.id@1",
      inputTokens: 199_000,
      outputTokens: 0,
      outcome: "ok",
      createdAt: spentAt,
    });
    const { deps, input, provider } = setup([solver("B", "2")]);

    const outcome = await verifyRequest(deps, await input(seeded));

    expect(outcome).toEqual({
      kind: "defer",
      runAfter: new Date(spentAt.getTime() + 86_400_000),
      reason: "quota_daily",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("treats a regeneration 429 past the cap as a marker", async () => {
    const seeded = await seed([failingClaim(1)]);
    for (let i = 0; i < 5; i += 1) {
      await database.db.insert(aiCalls).values({
        ownerId: USER_A,
        jobId: seeded.jobId,
        task: "generate_questions",
        provider: "groq",
        model: GENERATE_QUOTA.model,
        promptVersion: "generate-mc.id@1",
        inputTokens: 0,
        outputTokens: 0,
        outcome: "error",
        errorCode: "provider_rate_limited",
        createdAt: new Date(NOW.getTime() - (i + 2) * 3_600_000 * 30),
      });
    }
    const first = setup([solver("B", "2"), limited()]);

    const outcome = await verifyRequest(first.deps, await first.input(seeded));

    expect(outcome).toMatchObject({ kind: "done", regenerated: 0 });
    const generateErrors = (await database.db.select().from(aiCalls)).filter(
      (call) =>
        call.task === "generate_questions" &&
        call.outcome === "error" &&
        call.createdAt.getTime() === NOW.getTime(),
    );
    expect(generateErrors).toHaveLength(1);
    const forJob = (await database.db.select().from(aiCalls)).filter(
      (call) => call.jobId === seeded.jobId && call.task === "generate_questions",
    );
    expect(
      forJob.filter((call) => call.errorCode === "provider_rate_limited"),
    ).toHaveLength(5);
    expect(forJob.filter((call) => call.errorCode === "provider_busy")).toHaveLength(1);
    expect((await versionsOf()).versions).toHaveLength(1);

    const again = setup([]);
    const second = await verifyRequest(again.deps, await again.input(seeded));
    expect(second).toMatchObject({ kind: "done", regenerated: 0 });
    expect(again.provider.calls).toHaveLength(0);
    expect((await versionsOf()).versions).toHaveLength(1);
  });

  it("defers a regeneration 429 without a marker and regenerates on resume", async () => {
    const seeded = await seed([failingClaim(1)]);
    const first = setup([solver("B", "2"), limited(120_000)]);

    const outcome = await verifyRequest(first.deps, await first.input(seeded));

    expect(outcome).toEqual({
      kind: "defer",
      runAfter: new Date(NOW.getTime() + 120_000),
      reason: "provider",
    });
    expect((await versionsOf()).versions).toHaveLength(1);
    const generateErrors = (await database.db.select().from(aiCalls)).filter(
      (call) => call.task === "generate_questions" && call.outcome === "error",
    );
    expect(generateErrors).toHaveLength(1);
    expect(generateErrors[0]).toMatchObject({
      errorCode: "provider_rate_limited",
      inputTokens: 0,
      outputTokens: 0,
    });
    const runs = await database.db.select().from(verificationRuns);
    expect(
      runs.filter((run) => run.crossCheck && hasRegeneration(run.crossCheck)),
    ).toHaveLength(0);

    const second = setup([batchOf([questionJson(5)]), solver("B", "10")]);
    const done = await verifyRequest(second.deps, await second.input(seeded));
    expect(done).toMatchObject({ kind: "done", regenerated: 1 });
    expect((await versionsOf()).versions).toHaveLength(2);
  });
});

describe("correctionNoteFrom", () => {
  it("uses the first failing check's detail", () => {
    expect(
      correctionNoteFrom({
        checks: [
          { type: "numeric_eval", status: "pass", detail: "ok" },
          { type: "numeric_eval", status: "fail", detail: "1+1 = 2, bukan 99" },
        ],
        crossCheck: { verdict: "agree" },
      }),
    ).toBe("1+1 = 2, bukan 99");
  });

  it("falls back to the solver disagreement", () => {
    expect(
      correctionNoteFrom({ checks: [], crossCheck: { verdict: "disagree" } }),
    ).toContain("jawaban berbeda");
  });
});
