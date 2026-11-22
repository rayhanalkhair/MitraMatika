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
import {
  bankApprovedQuestions,
  getBankCount,
  getBankList,
  getBankQuestion,
  stemExcerpt,
} from "./bank";
import { bankQuerySchema } from "../schema/bank-query";
import { persistDrafts, type AnyDb } from "@/features/generation";
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

async function seedRequest(c: Curriculum, ownerId: string, count: number) {
  const { requestId } = await seedGenerationRequest(database.db, {
    ownerId,
    quantity: count,
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
      run: RUN(c),
      questions: Array.from({ length: count }, (_, i) =>
        multipleChoiceQuestionSchema.parse(questionJson(i + 1)),
      ),
      now: NOW,
    }),
  );
  return { requestId, ids: saved.questionIds };
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

async function seedScenario() {
  const c = await seedCurriculum(database.db);
  const main = await seedRequest(c, USER_A, 5);
  const [target, draft, rejected, regenerated, archivedCurrent] = main.ids as [
    string,
    string,
    string,
    string,
    string,
  ];
  await approve(target);
  // Archived (rejected) although approved_version_id still equals current_version_id: the status
  // check of the guarded update is the only thing keeping it out of the bank.
  await approve(archivedCurrent);
  await database.db
    .update(questions)
    .set({ status: "archived" })
    .where(eq(questions.id, archivedCurrent));
  await database.db
    .update(questions)
    .set({ status: "archived" })
    .where(eq(questions.id, rejected));
  await approve(regenerated);
  await database.db.transaction(async (tx) =>
    persistRegeneratedVersion(tx as unknown as AnyDb, {
      difficulty: "sedang",
      ownerId: USER_A,
      requestId: main.requestId,
      questionId: regenerated,
      topicId: c.topicId,
      sourceRef: c.sourceRef,
      run: RUN(c),
      question: multipleChoiceQuestionSchema.parse(questionJson(9)),
      now: NOW,
    }),
  );
  const other = await seedRequest(c, USER_A, 1);
  await approve(other.ids[0]);
  const foreign = await seedRequest(c, USER_B, 1);
  await approve(foreign.ids[0]);
  return {
    requestId: main.requestId,
    target,
    draft,
    rejected,
    regenerated,
    archivedCurrent,
    otherRequest: other.ids[0],
    foreign: foreign.ids[0],
    foreignRequestId: foreign.requestId,
  };
}

describe("bankApprovedQuestions", () => {
  it("saves only approved current unbanked questions of the request", async () => {
    const s = await seedScenario();
    const before = await Promise.all(
      [
        s.target,
        s.draft,
        s.rejected,
        s.regenerated,
        s.archivedCurrent,
        s.otherRequest,
        s.foreign,
      ].map(load),
    );

    const result = await bankApprovedQuestions(database.db, {
      ownerId: USER_A,
      requestId: s.requestId,
      now: LATER,
    });

    expect(result).toEqual({ saved: 1 });
    const banked = await load(s.target);
    expect(banked.bankedAt).toEqual(LATER);
    expect(banked.updatedAt).toEqual(LATER);
    expect(banked.rowVersion).toBe(before[0].rowVersion + 1);
    for (const [i, id] of [
      s.draft,
      s.rejected,
      s.regenerated,
      s.archivedCurrent,
      s.otherRequest,
      s.foreign,
    ].entries()) {
      const after = await load(id);
      expect(after.bankedAt).toBeNull();
      expect(after.rowVersion).toBe(before[i + 1].rowVersion);
    }
  });

  it("is idempotent: the second call saves nothing", async () => {
    const s = await seedScenario();
    const input = { ownerId: USER_A, requestId: s.requestId, now: LATER };
    expect(await bankApprovedQuestions(database.db as unknown as AnyDb, input)).toEqual({
      saved: 1,
    });
    const afterFirst = await load(s.target);
    expect(
      await bankApprovedQuestions(database.db as unknown as AnyDb, {
        ...input,
        now: new Date("2026-11-09T00:00:00.000Z"),
      }),
    ).toEqual({ saved: 0 });
    const afterSecond = await load(s.target);
    expect(afterSecond.rowVersion).toBe(afterFirst.rowVersion);
    expect(afterSecond.bankedAt).toEqual(LATER);
  });

  it("saves nothing for another owner's request, or when the owner does not match", async () => {
    const s = await seedScenario();
    const handle = database.db as unknown as AnyDb;
    expect(
      await bankApprovedQuestions(handle, {
        ownerId: USER_B,
        requestId: s.requestId,
        now: LATER,
      }),
    ).toEqual({ saved: 0 });
    expect(
      await bankApprovedQuestions(handle, {
        ownerId: USER_A,
        requestId: s.foreignRequestId,
        now: LATER,
      }),
    ).toEqual({ saved: 0 });
    expect((await load(s.target)).bankedAt).toBeNull();
    expect((await load(s.foreign)).bankedAt).toBeNull();
  });

  it("works through runAsUser (RLS grant) for the owner and saves nothing for another user", async () => {
    const s = await seedScenario();
    const other = await runAsUser(database.db, USER_B, (tx) =>
      bankApprovedQuestions(tx as unknown as AnyDb, {
        ownerId: USER_B,
        requestId: s.requestId,
        now: LATER,
      }),
    );
    expect(other).toEqual({ saved: 0 });
    const own = await runAsUser(database.db, USER_A, (tx) =>
      bankApprovedQuestions(tx as unknown as AnyDb, {
        ownerId: USER_A,
        requestId: s.requestId,
        now: LATER,
      }),
    );
    expect(own).toEqual({ saved: 1 });
    expect((await load(s.target)).bankedAt).toEqual(LATER);
    expect((await load(s.foreign)).bankedAt).toBeNull();
  });
});

async function setBanked(ids: string[], at: Date) {
  for (const id of ids) {
    await database.db.update(questions).set({ bankedAt: at }).where(eq(questions.id, id));
  }
}

// banked_at is set on every kind of question, but only the approved, current ones are in the bank.
async function seedBank() {
  const s = await seedScenario();
  const older = await seedRequest(await seedCurriculum(database.db, "v2"), USER_A, 2);
  await approve(older.ids[0]);
  await setBanked([older.ids[0]], new Date("2026-11-07T08:00:00.000Z"));
  await setBanked([s.target, s.foreign], LATER);
  // The regenerated question is not banked here: a banked one whose approval waits on an older
  // version stays in the bank (R19), covered on its own below.
  await setBanked([s.draft, s.rejected, s.archivedCurrent], LATER);
  return { ...s, older: older.ids[0] };
}

const parse = (params: Record<string, unknown>) => bankQuerySchema.parse(params);
const listIds = async (ownerId: string, params: Record<string, unknown> = {}) =>
  (
    await getBankList(database.db as unknown as AnyDb, { ownerId, query: parse(params) })
  ).items.map((item) => item.questionId);
const setText = async (id: string, searchText: string) => {
  await database.db.update(questions).set({ searchText }).where(eq(questions.id, id));
};

// A third banked, approved question of USER_A, banked at `at`.
async function bankedExtra(at: Date) {
  const extra = await seedRequest(await seedCurriculum(database.db, "v9"), USER_A, 1);
  await approve(extra.ids[0]);
  await setBanked([extra.ids[0]], at);
  return extra.ids[0];
}

const versionOf = async (questionId: string) =>
  (await load(questionId)).currentVersionId!;

describe("getBankCount", () => {
  it("counts only the owner's banked, approved, current questions", async () => {
    await seedBank();
    const handle = database.db as unknown as AnyDb;
    expect(await getBankCount(handle, { ownerId: USER_A })).toBe(2);
    expect(await getBankCount(handle, { ownerId: USER_B })).toBe(1);
    expect(
      await getBankCount(handle, { ownerId: "00000000-0000-4000-8000-0000000000ff" }),
    ).toBe(0);
  });

  it("works through runAsUser", async () => {
    await seedBank();
    const n = await runAsUser(database.db, USER_A, (tx) =>
      getBankCount(tx as unknown as AnyDb, { ownerId: USER_A }),
    );
    expect(n).toBe(2);
  });
});

describe("getBankList", () => {
  it("returns only banked questions of the owner, newest first", async () => {
    const s = await seedBank();
    expect(await listIds(USER_A)).toEqual([s.target, s.older]);
  });

  it("never mixes owners", async () => {
    const s = await seedBank();
    expect(await listIds(USER_B)).toEqual([s.foreign]);
    expect(await listIds("00000000-0000-4000-8000-0000000000ff")).toEqual([]);
  });

  it("fills the whitelisted item fields", async () => {
    const s = await seedBank();
    await insertVerificationRun(database.db, {
      ownerId: USER_A,
      versionId: await versionOf(s.target),
      verifierVersion: "p1-12.1",
      status: "terverifikasi",
      checks: [],
      crossCheck: { provider: "groq", model: "openai/gpt-oss-20b", verdict: "agree" },
      now: NOW,
    });
    const { items: list } = await getBankList(database.db, {
      ownerId: USER_A,
      query: parse({}),
    });
    const item = list.find((entry) => entry.questionId === s.target)!;
    expect(item).toEqual({
      questionId: s.target,
      topicTitle: "SPLDV",
      objectiveCode: "TP-3",
      difficulty: "sedang",
      type: "multiple_choice",
      status: "terverifikasi",
      stemExcerptMd: expect.stringMatching(/^Hitung/) as unknown,
      versionNo: 1,
      bankedAt: LATER.toISOString(),
    });
    const unverified = list.find((entry) => entry.questionId === s.older)!;
    expect(unverified.status).toBe("belum_dapat_diverifikasi");
    expect(JSON.stringify(list)).not.toMatch(/groq|gpt-oss|machine|override/i);
  });

  it("works through runAsUser", async () => {
    const s = await seedBank();
    const list = await runAsUser(database.db, USER_A, (tx) =>
      getBankList(tx as unknown as AnyDb, { ownerId: USER_A, query: parse({}) }),
    );
    expect(list.items.map((item) => item.questionId)).toEqual([s.target, s.older]);
  });
});

describe("getBankList ordering", () => {
  it("orders questions banked at the same instant by id", async () => {
    const s = await seedScenario();
    const second = await seedRequest(await seedCurriculum(database.db, "v3"), USER_A, 1);
    await approve(second.ids[0]);
    await setBanked([s.target, second.ids[0]], LATER);
    const expected = [s.target, second.ids[0]].sort();
    expect(await listIds(USER_A)).toEqual(expected);
  });
});

describe("getBankList filters, search and pagination", () => {
  it("filters by grade", async () => {
    const s = await seedBank();
    await database.db
      .update(questions)
      .set({ grade: 9 })
      .where(eq(questions.id, s.older));
    expect(await listIds(USER_A, { grade: "9" })).toEqual([s.older]);
    expect(await listIds(USER_A, { grade: "8" })).toEqual([s.target]);
    expect(await listIds(USER_A, { grade: "7" })).toEqual([]);
  });

  it("filters by topic and by element", async () => {
    const s = await seedBank();
    const topicOf = async (id: string) => (await load(id)).topicId;
    expect(await listIds(USER_A, { topicId: await topicOf(s.older) })).toEqual([s.older]);
    const [element] = await database.db
      .select({ id: topics.cpElementId })
      .from(topics)
      .where(eq(topics.id, await topicOf(s.target)));
    expect(await listIds(USER_A, { elementId: element.id })).toEqual([s.target]);
  });

  it("filters by difficulty, type and origin", async () => {
    const s = await seedBank();
    await database.db
      .update(questions)
      .set({ difficulty: "sulit", origin: "manual" })
      .where(eq(questions.id, s.older));
    expect(await listIds(USER_A, { difficulty: "sulit" })).toEqual([s.older]);
    expect(await listIds(USER_A, { difficulty: "mudah" })).toEqual([]);
    expect(await listIds(USER_A, { origin: "manual" })).toEqual([s.older]);
    expect(await listIds(USER_A, { origin: "generated" })).toEqual([s.target]);
    expect(await listIds(USER_A, { type: "multiple_choice" })).toEqual([
      s.target,
      s.older,
    ]);
  });

  it("filters by the effective verification status", async () => {
    const s = await seedBank();
    const verify = async (id: string, status: "terverifikasi" | "dicek_silang") =>
      insertVerificationRun(database.db, {
        ownerId: USER_A,
        versionId: await versionOf(id),
        verifierVersion: "p1-12.1",
        status,
        checks: [],
        crossCheck: {},
        now: NOW,
      });
    await verify(s.target, "terverifikasi");
    await verify(s.older, "dicek_silang");
    expect(await listIds(USER_A, { status: "terverifikasi" })).toEqual([s.target]);
    expect(await listIds(USER_A, { status: "dicek_silang" })).toEqual([s.older]);
    expect(await listIds(USER_A, { status: "ketidaksesuaian" })).toEqual([]);
    expect(await listIds(USER_A, { status: "belum_dapat_diverifikasi" })).toEqual([]);
  });

  it("falls back to the version's own status and ignores regeneration markers", async () => {
    const s = await seedBank();
    await insertVerificationRun(database.db, {
      ownerId: USER_A,
      versionId: await versionOf(s.target),
      verifierVersion: "p1-12.1",
      status: "terverifikasi",
      checks: [],
      crossCheck: {},
      now: NOW,
    });
    // A later regeneration marker (status ketidaksesuaian) is history, not a verification run.
    await insertRegenerationMarker(database.db, {
      ownerId: USER_A,
      versionId: await versionOf(s.target),
      now: LATER,
    });
    expect(await listIds(USER_A, { status: "terverifikasi" })).toEqual([s.target]);
    expect(await listIds(USER_A, { status: "ketidaksesuaian" })).toEqual([]);
    expect(await listIds(USER_A, { status: "belum_dapat_diverifikasi" })).toEqual([
      s.older,
    ]);
  });

  it("filters by the saved-on date range, inclusive, in Jakarta time", async () => {
    const s = await seedBank();
    // older: 7 Nov 08:00 UTC = 7 Nov 15:00 WIB; target: 8 Nov 11:00 UTC = 8 Nov 18:00 WIB.
    expect(await listIds(USER_A, { from: "2026-11-08" })).toEqual([s.target]);
    expect(await listIds(USER_A, { to: "2026-11-07" })).toEqual([s.older]);
    expect(await listIds(USER_A, { from: "2026-11-07", to: "2026-11-08" })).toEqual([
      s.target,
      s.older,
    ]);
    expect(await listIds(USER_A, { from: "2026-11-09" })).toEqual([]);
  });

  it("puts 17:00-23:59 UTC on the next Jakarta day at the range edges", async () => {
    const s = await seedBank();
    // 8 Nov 17:30 UTC = 9 Nov 00:30 WIB.
    const late = await bankedExtra(new Date("2026-11-08T17:30:00.000Z"));
    expect(await listIds(USER_A, { from: "2026-11-09" })).toEqual([late]);
    expect(await listIds(USER_A, { to: "2026-11-08" })).toEqual([s.target, s.older]);
    expect(await listIds(USER_A, { from: "2026-11-09", to: "2026-11-09" })).toEqual([
      late,
    ]);
  });

  it("matches stem words and the TP code, ignoring case and accents", async () => {
    const s = await seedBank();
    await setText(s.target, "hitung luas segitiga tp-4");
    await setText(s.older, "tentukan keliling tp-3");
    expect(await listIds(USER_A, { q: "SEGITIGA" })).toEqual([s.target]);
    expect(await listIds(USER_A, { q: "tp-3" })).toEqual([s.older]);
    expect(await listIds(USER_A, { q: "Ségitiga" })).toEqual([s.target]);
    expect(await listIds(USER_A, { q: "tidak ada" })).toEqual([]);
  });

  it("matches a TP code exactly: another TP code is not a fuzzy hit", async () => {
    const s = await seedBank();
    await setText(s.target, "hitung 2 + 2 tp-4 tp-5");
    await setText(s.older, "hitung 3 + 3 tp-33");
    expect(await listIds(USER_A, { q: "tp-3" })).toEqual([s.older]);
    expect(await listIds(USER_A, { q: "tp-4" })).toEqual([s.target]);
  });

  it("keeps the chosen sort while searching", async () => {
    const s = await seedBank();
    await setText(s.target, "persamaan linear");
    await setText(s.older, "persamaan linear dua variabel panjang sekali");
    expect(await listIds(USER_A, { q: "persamaan", sort: "oldest" })).toEqual([
      s.older,
      s.target,
    ]);
    expect(await listIds(USER_A, { q: "persamaan", sort: "newest" })).toEqual([
      s.target,
      s.older,
    ]);
  });

  it("treats LIKE wildcards in the query literally", async () => {
    const s = await seedBank();
    await setText(s.target, "diskon 50% hari ini");
    await setText(s.older, "diskon 500 rupiah");
    expect(await listIds(USER_A, { q: "50%" })).toEqual([s.target]);
    expect(await listIds(USER_A, { q: "_" })).toEqual([]);
  });

  it("finds a close misspelling of a longer query", async () => {
    const s = await seedBank();
    await setText(s.target, "persamaan linear dua variabel");
    await setText(s.older, "teorema pythagoras segitiga");
    expect(await listIds(USER_A, { q: "persamaan linier" })).toEqual([s.target]);
  });

  it("does not error on a query with LaTeX or SQL punctuation", async () => {
    const s = await seedBank();
    await setText(s.target, "hitung 1 2 + 3");
    await setText(s.older, "tidak berkaitan");
    expect(await listIds(USER_A, { q: "$\\frac{1}{2}$" })).toEqual([s.target]);
    expect(await listIds(USER_A, { q: "'; drop table questions; --" })).toEqual([]);
    // Nothing left after normalising: no search filter at all.
    expect(await listIds(USER_A, { q: "\\alpha" })).toEqual([s.target, s.older]);
  });

  it("never lists trashed questions, and counts and facets skip them", async () => {
    const s = await seedBank();
    await database.db
      .update(questions)
      .set({ deletedAt: LATER, purgeAfter: LATER })
      .where(eq(questions.id, s.target));
    const handle = database.db as unknown as AnyDb;
    const result = await getBankList(handle, { ownerId: USER_A, query: parse({}) });
    expect(result.items.map((i) => i.questionId)).toEqual([s.older]);
    expect(result.total).toBe(1);
    expect(result.facets.topics).toHaveLength(1);
    expect(await getBankCount(handle, { ownerId: USER_A })).toBe(1);
    expect(
      await getBankQuestion(handle, { ownerId: USER_A, questionId: s.target }),
    ).toBeNull();
  });

  it("sorts newest, oldest and by difficulty", async () => {
    const s = await seedBank();
    const middle = await bankedExtra(new Date("2026-11-07T12:00:00.000Z"));
    // newest -> oldest: target (sulit), middle (mudah), older (sedang): difficulty order
    // (mudah, sedang, sulit) differs from both newest-first and oldest-first.
    const set = (id: string, difficulty: string) =>
      database.db.update(questions).set({ difficulty }).where(eq(questions.id, id));
    await set(s.target, "sulit");
    await set(middle, "mudah");
    await set(s.older, "sedang");
    expect(await listIds(USER_A, { sort: "newest" })).toEqual([
      s.target,
      middle,
      s.older,
    ]);
    expect(await listIds(USER_A, { sort: "oldest" })).toEqual([
      s.older,
      middle,
      s.target,
    ]);
    expect(await listIds(USER_A, { sort: "difficulty" })).toEqual([
      middle,
      s.older,
      s.target,
    ]);
  });

  it("paginates 45 items as 20 + 20 + 5 with a page count of 3", async () => {
    const c = await seedCurriculum(database.db);
    const many = await seedRequest(c, USER_A, 45);
    for (const id of many.ids) await approve(id);
    await setBanked(many.ids, LATER);
    const handle = database.db as unknown as AnyDb;

    const page2 = await getBankList(handle, {
      ownerId: USER_A,
      query: parse({ page: "2" }),
    });
    expect(page2).toMatchObject({ total: 45, page: 2, pageCount: 3 });
    expect(page2.items).toHaveLength(20);
    const page1 = await listIds(USER_A, { page: "1" });
    const page3 = await listIds(USER_A, { page: "3" });
    expect(page1).toHaveLength(20);
    expect(page3).toHaveLength(5);
    const all = new Set([...page1, ...page2.items.map((i) => i.questionId), ...page3]);
    expect(all.size).toBe(45);
  });

  it("clamps a page past the end to the last page and returns one empty page for no items", async () => {
    const s = await seedBank();
    const handle = database.db as unknown as AnyDb;
    const beyond = await getBankList(handle, {
      ownerId: USER_A,
      query: parse({ page: "9" }),
    });
    expect(beyond).toMatchObject({ page: 1, pageCount: 1, total: 2 });
    expect(beyond.items.map((i) => i.questionId)).toEqual([s.target, s.older]);
    const none = await getBankList(handle, {
      ownerId: "00000000-0000-4000-8000-0000000000ff",
      query: parse({}),
    });
    expect(none).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageCount: 1,
      facets: { grades: [], elements: [], topics: [] },
    });
  });

  it("returns facets of the owner's whole bank, not narrowed by the filters", async () => {
    const s = await seedBank();
    await database.db
      .update(questions)
      .set({ grade: 9 })
      .where(eq(questions.id, s.older));
    const result = await getBankList(database.db, {
      ownerId: USER_A,
      query: parse({ grade: "9" }),
    });
    expect(result.items.map((i) => i.questionId)).toEqual([s.older]);
    expect(result.facets.grades).toEqual([8, 9]);
    expect(result.facets.topics.map((t) => t.title)).toEqual(["SPLDV", "SPLDV"]);
    expect(result.facets.elements.map((e) => e.name)).toEqual(["Aljabar", "Aljabar"]);
  });
});

describe("getBankQuestion", () => {
  it("returns the approved version with curriculum and bankedAt", async () => {
    const s = await seedBank();
    const detail = await getBankQuestion(database.db, {
      ownerId: USER_A,
      questionId: s.target,
    });
    expect(detail).toMatchObject({
      bankedAt: LATER.toISOString(),
      question: {
        questionId: s.target,
        versionNo: 1,
        decision: "approved",
        banked: true,
        correctLabel: "B",
      },
      curriculum: { topicTitle: "SPLDV", versionCode: "v1" },
    });
    expect(detail!.question.versionId).toBe(await versionOf(s.target));
  });

  it("shows the approved version while a regeneration of a banked question waits (R19)", async () => {
    const s = await seedBank();
    await setBanked([s.regenerated], LATER);
    const handle = database.db as unknown as AnyDb;
    const detail = await getBankQuestion(handle, {
      ownerId: USER_A,
      questionId: s.regenerated,
    });
    const approved = (await load(s.regenerated)).approvedVersionId;
    expect(detail?.question.versionId).toBe(approved);
    expect(detail?.question.stemMd).not.toBe("Hitung $9 + 9$.");
    expect(await listIds(USER_A)).toContain(s.regenerated);
  });

  it("returns null for unknown, foreign, unbanked, rejected and stale questions", async () => {
    const s = await seedBank();
    const handle = database.db as unknown as AnyDb;
    const get = (ownerId: string, questionId: string) =>
      getBankQuestion(handle, { ownerId, questionId });
    expect(await get(USER_A, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await get(USER_A, s.foreign)).toBeNull();
    expect(await get(USER_B, s.target)).toBeNull();
    expect(await get(USER_A, s.draft)).toBeNull();
    expect(await get(USER_A, s.rejected)).toBeNull();
    expect(await get(USER_A, s.archivedCurrent)).toBeNull();
    // approved, then regenerated, never banked
    expect(await get(USER_A, s.regenerated)).toBeNull();
    // approved but never saved
    expect(await get(USER_A, s.otherRequest)).toBeNull();
  });

  it("never exposes machine answers, model names, tokens, prompts or the override note", async () => {
    const s = await seedBank();
    await database.db
      .update(questions)
      .set({ approvalOverride: { note: "catatan rahasia guru" } })
      .where(eq(questions.id, s.target));
    const detail = await getBankQuestion(database.db, {
      ownerId: USER_A,
      questionId: s.target,
    });
    const json = JSON.stringify(detail);
    expect(json).not.toMatch(
      /machine|groq|gpt-oss|promptVersion|tokens|catatan rahasia/i,
    );
    expect(detail!.question.override).toBe(true);
    expect(Object.keys(detail!).sort()).toEqual(["bankedAt", "curriculum", "question"]);
  });

  it("is under RLS for the owner", async () => {
    const s = await seedBank();
    const own = await runAsUser(database.db, USER_A, (tx) =>
      getBankQuestion(tx as unknown as AnyDb, { ownerId: USER_A, questionId: s.target }),
    );
    expect(own?.question.questionId).toBe(s.target);
    const other = await runAsUser(database.db, USER_B, (tx) =>
      getBankQuestion(tx as unknown as AnyDb, { ownerId: USER_B, questionId: s.target }),
    );
    expect(other).toBeNull();
  });
});

describe("stemExcerpt", () => {
  it("leaves short text unchanged and handles the empty string", () => {
    expect(stemExcerpt("Hitung $1 + 1$.", 100)).toBe("Hitung $1 + 1$.");
    expect(stemExcerpt("", 10)).toBe("");
  });

  it("cuts at whitespace and appends an ellipsis", () => {
    expect(stemExcerpt("satu dua tiga empat", 12)).toBe("satu dua…");
    expect(stemExcerpt("satudua tigaempat", 5)).toBe("satud…");
  });

  it("drops an unbalanced dollar from the last one", () => {
    expect(stemExcerpt("Hitung $x + y = 10 dan seterusnya", 18)).toBe("Hitung…");
  });

  it("keeps balanced math and ignores escaped dollars when counting", () => {
    expect(stemExcerpt("Hitung $x$ lalu bagi dengan dua", 16)).toBe("Hitung $x$ lalu…");
    expect(stemExcerpt("Harga \\$5 untuk setiap buku itu", 14)).toBe("Harga \\$5…");
  });

  it("closes or drops a display span cut inside $$...$$", () => {
    expect(stemExcerpt("Hitung $$x + y = 10$$ lalu selesai", 15)).toBe("Hitung…");
    expect(stemExcerpt("Hitung $$x$$ lalu bagi dengan dua", 17)).toBe(
      "Hitung $$x$$ lalu…",
    );
  });

  it("keeps the first math span whole when the stem starts with math that does not fit", () => {
    expect(stemExcerpt("$x + y + z$ ditambah banyak sekali teks", 6)).toBe(
      "$x + y + z$…",
    );
    expect(stemExcerpt("$$x + y + z$$ ditambah banyak sekali teks", 6)).toBe(
      "$$x + y + z$$…",
    );
  });

  it("never returns only the ellipsis, even for math that never closes", () => {
    const result = stemExcerpt("$x + y tanpa penutup sama sekali", 6);
    expect(result).not.toBe("…");
    expect(result).not.toContain("$");
  });

  it("cuts a long single token at max", () => {
    expect(stemExcerpt("a".repeat(200), 140)).toBe(`${"a".repeat(140)}…`);
  });
});
