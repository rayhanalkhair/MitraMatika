import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser } from "@/lib/db/client";
import {
  assessmentItems,
  assessments,
  questions,
  questionSources,
  questionVersions,
  schoolTemplates,
  verificationRuns,
} from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { seedCurriculum } from "@/features/generation";
import { editQuestion } from "@/features/review";
import { setDefaultTemplate } from "@/features/templates";
import { ASSESSMENT_INPUT, clearAll, seedBankedQuestions } from "../test-support";
import {
  approve,
  checkApproval,
  computeSnapshotHash,
  getApprovalState,
  isApprovedAndValid,
  loadSnapshot,
  reopen,
  verifyApproval,
  type ApprovalSnapshot,
  type SnapshotItem,
  type TemplatePrint,
} from "./approval";
import { createAssessment, type AssessmentDb } from "./assessments";
import { addItems, moveItem } from "./items";
import { addSection } from "./sections";
import { setPoints, setScoringMode, setShuffle } from "./settings";

// ---------------------------------------------------------------------------------------------
// checkApproval (pure)

const item = (n: number, over: Partial<SnapshotItem> = {}): SnapshotItem => ({
  itemId: `item-${String(n)}`,
  questionId: `q-${String(n)}`,
  versionId: `v-${String(n)}`,
  storedPoints: 0,
  questionApproved: true,
  pinnedIsApproved: true,
  trashed: false,
  mismatch: false,
  overridden: false,
  ...over,
});

const PRINTED: TemplatePrint = {
  schoolName: "SMP 1",
  headerLines: ["PEMERINTAH KOTA"],
  logo: null,
  subject: "Matematika",
  studentFields: ["name"],
  defaultInstructionsMd: null,
  paperSize: "A4",
  font: "times",
};

const snapshot = (over: Partial<ApprovalSnapshot> = {}): ApprovalSnapshot => ({
  assessmentId: "a",
  title: "Ulangan",
  kind: "latihan",
  grade: 8,
  examDate: null,
  durationMinutes: null,
  instructionsMd: null,
  scoringMode: "equal",
  shuffleSeed: null,
  template: { id: "t", trashed: false, printed: PRINTED },
  sections: [
    { id: "s1", title: "A", instructionsMd: null, items: [item(1), item(2)] },
    { id: "s2", title: "B", instructionsMd: null, items: [item(3)] },
  ],
  ...over,
});

describe("checkApproval", () => {
  it("passes a complete assessment with equal scoring", () => {
    expect(checkApproval(snapshot())).toEqual({ ok: true, data: undefined });
  });

  it("refuses an empty assessment with only `empty`", () => {
    const empty = snapshot({
      sections: [{ id: "s1", title: "A", instructionsMd: null, items: [] }],
    });
    expect(checkApproval(empty)).toEqual({ ok: false, error: [{ code: "empty" }] });
  });

  it("lists every problem, each with the item number in the outline", () => {
    const result = checkApproval(
      snapshot({
        scoringMode: "manual",
        template: { id: "t", trashed: true, printed: PRINTED },
        sections: [
          {
            id: "s1",
            title: "A",
            instructionsMd: null,
            items: [
              item(1, { questionApproved: false, storedPoints: 5 }),
              item(2, { mismatch: true, storedPoints: 5 }),
              // A mismatch the teacher approved with a note is resolved.
              item(3, { mismatch: true, overridden: true, storedPoints: 5 }),
            ],
          },
          {
            id: "s2",
            title: "B",
            instructionsMd: null,
            items: [
              item(4, { trashed: true, questionApproved: false, storedPoints: 5 }),
              item(5, { storedPoints: 0 }),
            ],
          },
        ],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: [
        { code: "trashed", template: true },
        { code: "notApproved", itemId: "item-1", number: 1 },
        { code: "mismatch", itemId: "item-2", number: 2 },
        { code: "trashed", itemId: "item-4", number: 4 },
        { code: "notApproved", itemId: "item-4", number: 4 },
        {
          code: "badTotal",
          mode: "manual",
          total: 20,
          unscored: [{ itemId: "item-5", number: 5 }],
        },
      ],
    });
  });

  it("manual accepts any positive total; normalised needs points on every item", () => {
    const points = (values: number[]) => [
      {
        id: "s1",
        title: "A",
        instructionsMd: null,
        items: values.map((storedPoints, i) => item(i + 1, { storedPoints })),
      },
    ];
    expect(
      checkApproval(snapshot({ scoringMode: "manual", sections: points([3, 4]) })),
    ).toEqual({ ok: true, data: undefined });
    expect(
      checkApproval(snapshot({ scoringMode: "normalised", sections: points([3, 4]) })),
    ).toEqual({ ok: true, data: undefined });
    expect(
      checkApproval(snapshot({ scoringMode: "normalised", sections: points([0, 0]) })),
    ).toEqual({
      ok: false,
      error: [
        {
          code: "badTotal",
          mode: "normalised",
          total: 0,
          unscored: [
            { itemId: "item-1", number: 1 },
            { itemId: "item-2", number: 2 },
          ],
        },
      ],
    });
    expect(
      checkApproval(snapshot({ scoringMode: "manual", sections: points([0, 0]) })),
    ).toEqual({
      ok: false,
      error: [
        {
          code: "badTotal",
          mode: "manual",
          total: 0,
          unscored: [
            { itemId: "item-1", number: 1 },
            { itemId: "item-2", number: 2 },
          ],
        },
      ],
    });
  });

  it("refuses a pin that is not the question's approved version (R11)", () => {
    const pins = snapshot({
      sections: [
        {
          id: "s1",
          title: "A",
          instructionsMd: null,
          items: [item(1, { pinnedIsApproved: false }), item(2)],
        },
      ],
    });
    expect(checkApproval(pins)).toEqual({
      ok: false,
      error: [{ code: "notApproved", itemId: "item-1", number: 1 }],
    });
  });

  it("does not require a template", () => {
    expect(checkApproval(snapshot({ template: null }))).toEqual({
      ok: true,
      data: undefined,
    });
  });
});

describe("computeSnapshotHash", () => {
  it("is a sha-256 hex digest independent of key order", () => {
    // The same snapshot with the keys of every object inserted in reverse order.
    const reverseKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverseKeys)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, inner]) => [key, reverseKeys(inner)]),
            )
          : value;
    const one = snapshot();
    const reordered = reverseKeys(one) as ApprovalSnapshot;
    expect(Object.keys(reordered)[0]).toBe("sections");
    expect(computeSnapshotHash(one)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeSnapshotHash(reordered)).toBe(computeSnapshotHash(one));
  });

  it("covers every printed template field, the header lines in order and the logo (R26)", () => {
    const base = computeSnapshotHash(snapshot());
    const printed: Partial<TemplatePrint>[] = [
      { schoolName: "SMP 2" },
      { headerLines: ["PEMERINTAH KOTA", "DINAS PENDIDIKAN"] },
      { subject: "IPA" },
      { studentFields: ["name", "class"] },
      { defaultInstructionsMd: "Kerjakan sendiri." },
      { paperSize: "F4" },
      { font: "arial" },
      { logo: { key: "templates/o/t/logo.png", sha256: "a".repeat(64) } },
    ];
    const withPrinted = (change: Partial<TemplatePrint>) =>
      computeSnapshotHash(
        snapshot({
          template: { id: "t", trashed: false, printed: { ...PRINTED, ...change } },
        }),
      );
    const hashes = printed.map(withPrinted);
    expect(hashes).not.toContain(base);
    expect(new Set(hashes).size).toBe(hashes.length);
    // A same-format replacement keeps the key: the content hash tells them apart.
    const logo = (sha256: string | null) =>
      withPrinted({ logo: { key: "templates/o/t/logo.png", sha256 } });
    expect(logo("a".repeat(64))).not.toBe(logo("b".repeat(64)));
    expect(withPrinted({ headerLines: ["A", "B"] })).not.toBe(
      withPrinted({ headerLines: ["B", "A"] }),
    );
  });

  it("changes with the order, points, seed, scoring mode, template and pinned versions", () => {
    const base = computeSnapshotHash(snapshot());
    const variants: ApprovalSnapshot[] = [
      snapshot({
        sections: [
          { id: "s1", title: "A", instructionsMd: null, items: [item(2), item(1)] },
          { id: "s2", title: "B", instructionsMd: null, items: [item(3)] },
        ],
      }),
      snapshot({ scoringMode: "manual" }),
      snapshot({ shuffleSeed: 42 }),
      snapshot({ template: { id: "t2", trashed: false, printed: PRINTED } }),
      snapshot({
        sections: [
          {
            id: "s1",
            title: "A",
            instructionsMd: null,
            items: [item(1, { versionId: "v-9" }), item(2)],
          },
          { id: "s2", title: "B", instructionsMd: null, items: [item(3)] },
        ],
      }),
      snapshot({ title: "Ulangan 2" }),
    ];
    const hashes = variants.map(computeSnapshotHash);
    for (const hash of hashes) expect(hash).not.toBe(base);
    expect(new Set(hashes).size).toBe(hashes.length);
    // Points: manual 1/2/3 versus manual 1/2/4.
    const manual = (last: number) =>
      snapshot({
        scoringMode: "manual",
        sections: [
          {
            id: "s1",
            title: "A",
            instructionsMd: null,
            items: [item(1, { storedPoints: 1 }), item(2, { storedPoints: 2 })],
          },
          {
            id: "s2",
            title: "B",
            instructionsMd: null,
            items: [item(3, { storedPoints: last })],
          },
        ],
      });
    expect(computeSnapshotHash(manual(3))).not.toBe(computeSnapshotHash(manual(4)));
  });

  it("ignores the stored points in equal mode (they do not reach the paper)", () => {
    const withPoints = snapshot({
      sections: [
        {
          id: "s1",
          title: "A",
          instructionsMd: null,
          items: [item(1, { storedPoints: 9 }), item(2)],
        },
        { id: "s2", title: "B", instructionsMd: null, items: [item(3)] },
      ],
    });
    expect(computeSnapshotHash(withPoints)).toBe(computeSnapshotHash(snapshot()));
  });
});

// ---------------------------------------------------------------------------------------------
// approve, reopen and the export gate (PGlite, real RLS)

let database: TestDatabase;
const db = () => database.db as unknown as AssessmentDb;
const NOW = new Date("2026-11-19T10:00:00.000Z");

const asUser = <T>(userId: string, fn: (tx: AssessmentDb) => Promise<T>) =>
  runAsUser(db(), userId, (tx) => fn(tx as unknown as AssessmentDb));

async function seed() {
  const curriculum = await seedCurriculum(database.db);
  const a = await seedBankedQuestions(database, {
    ownerId: USER_A,
    count: 4,
    curriculum,
  });
  const [template] = await database.db
    .insert(schoolTemplates)
    .values({ ownerId: USER_A, name: "T", schoolName: "SMP 1" })
    .returning({ id: schoolTemplates.id });
  const created = await asUser(USER_A, async (tx) => {
    const result = await createAssessment(tx, {
      ownerId: USER_A,
      input: { ...ASSESSMENT_INPUT, templateId: template.id },
    });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  });
  const second = await asUser(USER_A, async (tx) => {
    const result = await addSection(tx, {
      ownerId: USER_A,
      assessmentId: created.id,
      title: "B. Uraian",
    });
    if (!result.ok) throw new Error(result.error);
    return result.data.id;
  });
  await asUser(USER_A, (tx) =>
    addItems(tx, {
      ownerId: USER_A,
      assessmentId: created.id,
      sectionId: created.sectionId,
      questionIds: a.slice(0, 3),
    }),
  );
  await asUser(USER_A, (tx) =>
    addItems(tx, {
      ownerId: USER_A,
      assessmentId: created.id,
      sectionId: second,
      questionIds: a.slice(3),
    }),
  );
  const items = await database.db
    .select()
    .from(assessmentItems)
    .where(eq(assessmentItems.assessmentId, created.id))
    .orderBy(asc(assessmentItems.sectionId), asc(assessmentItems.sortOrder));
  const itemOf = (index: number) => {
    const found = items.find((row) => row.questionId === a[index]);
    if (!found) throw new Error("no item");
    return found;
  };
  return { a, assessmentId: created.id, templateId: template.id, itemOf };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const row = async (assessmentId: string) =>
  (
    await database.db.select().from(assessments).where(eq(assessments.id, assessmentId))
  )[0];

const doApprove = (s: Seed, owner = USER_A, expectedHash?: string) =>
  asUser(owner, (tx) =>
    approve(tx, { ownerId: owner, assessmentId: s.assessmentId, expectedHash, now: NOW }),
  );

const currentHash = async (s: Seed) => {
  const state = await asUser(USER_A, (tx) =>
    getApprovalState(tx, { ownerId: USER_A, assessmentId: s.assessmentId }),
  );
  if (!state) throw new Error("no state");
  return state.hash;
};

/** A clean teacher edit of a banked question (a new version; approval moves to it). */
async function editBanked(questionId: string) {
  const [question] = await database.db
    .select()
    .from(questions)
    .where(eq(questions.id, questionId));
  const [version] = await database.db
    .select()
    .from(questionVersions)
    .where(eq(questionVersions.id, question.currentVersionId ?? ""));
  const options = version.options as { label: "A" | "B" | "C" | "D"; text_md: string }[];
  const answer = version.answer as {
    display_md: string;
    correctLabel: "A" | "B" | "C" | "D";
  };
  const result = await editQuestion(database.db, {
    ownerId: USER_A,
    questionId,
    expectedRowVersion: question.rowVersion,
    content: {
      stemMd: `${version.stemMd} (revisi)`,
      options: options.map((o) => ({ label: o.label, textMd: o.text_md })),
      correctLabel: answer.correctLabel,
      answerDisplayMd: answer.display_md,
      explanationMd: version.explanationMd,
      steps: version.steps as string[],
    },
    now: NOW,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const [after] = await database.db
    .select()
    .from(questions)
    .where(eq(questions.id, questionId));
  if (after.approvedVersionId !== after.currentVersionId) {
    throw new Error("approval did not move to the edited version");
  }
}

const valid = (s: Seed, owner = USER_A) =>
  isApprovedAndValid(db(), { ownerId: owner, assessmentId: s.assessmentId });

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await clearAll(database);
});

describe("approve", () => {
  it(
    "approves a ready assessment and stores the hash of what it recomputed under the lock",
    async () => {
      const s = await seed();
      const result = await doApprove(s);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const stored = await row(s.assessmentId);
      expect(stored.status).toBe("approved");
      expect(stored.approvedAt?.toISOString()).toBe(NOW.toISOString());
      const loaded = await loadSnapshot(db(), {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
      });
      if (!loaded) throw new Error("no snapshot");
      expect(stored.approvedSnapshotHash).toBe(computeSnapshotHash(loaded.snapshot));
      expect(result.data.hash).toBe(stored.approvedSnapshotHash);
      expect(await valid(s)).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses with every problem listed, by item number, and stays a draft",
    async () => {
      const s = await seed();
      // 1: in the trash. 2: back to draft (not approved). 3: an unresolved mismatch.
      // 4: manual scoring with no points on any item.
      await database.db
        .update(questions)
        .set({ deletedAt: NOW, purgeAfter: NOW })
        .where(eq(questions.id, s.a[0]));
      await database.db
        .update(questions)
        .set({
          status: "draft",
          approvedVersionId: null,
          approvedAt: null,
          bankedAt: null,
        })
        .where(eq(questions.id, s.a[1]));
      await database.db.insert(verificationRuns).values({
        ownerId: USER_A,
        questionVersionId: s.itemOf(2).questionVersionId,
        verifierVersion: "test",
        status: "ketidaksesuaian",
      });
      await asUser(USER_A, (tx) =>
        setScoringMode(tx, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          mode: "manual",
        }),
      );
      await asUser(USER_A, (tx) =>
        setPoints(tx, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          points: [
            { itemId: s.itemOf(0).id, points: 5 },
            { itemId: s.itemOf(1).id, points: 5 },
            { itemId: s.itemOf(2).id, points: 5 },
          ],
        }),
      );

      const result = await doApprove(s);
      expect(result).toEqual({
        ok: false,
        error: {
          code: "notReady",
          problems: [
            { code: "trashed", itemId: s.itemOf(0).id, number: 1 },
            { code: "notApproved", itemId: s.itemOf(1).id, number: 2 },
            { code: "mismatch", itemId: s.itemOf(2).id, number: 3 },
            {
              code: "badTotal",
              mode: "manual",
              total: 15,
              unscored: [{ itemId: s.itemOf(3).id, number: 4 }],
            },
          ],
        },
      });
      const stored = await row(s.assessmentId);
      expect(stored.status).toBe("draft");
      expect(stored.approvedSnapshotHash).toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "accepts a mismatch the teacher approved with a note for that version",
    async () => {
      const s = await seed();
      const versionId = s.itemOf(2).questionVersionId;
      await database.db.insert(verificationRuns).values({
        ownerId: USER_A,
        questionVersionId: versionId,
        verifierVersion: "test",
        status: "ketidaksesuaian",
      });
      expect(await doApprove(s)).toMatchObject({
        ok: false,
        error: { code: "notReady" },
      });
      await database.db
        .update(questions)
        .set({
          approvalOverride: {
            note: "Sudah saya periksa",
            versionId,
            at: NOW.toISOString(),
          },
        })
        .where(eq(questions.id, s.a[2]));
      expect(await doApprove(s)).toMatchObject({ ok: true });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "does not accept an override naming another version, or one without a note",
    async () => {
      const s = await seed();
      const versionId = s.itemOf(2).questionVersionId;
      await database.db.insert(verificationRuns).values({
        ownerId: USER_A,
        questionVersionId: versionId,
        verifierVersion: "test",
        status: "ketidaksesuaian",
      });
      const refused = {
        ok: false,
        error: {
          code: "notReady",
          problems: [{ code: "mismatch", itemId: s.itemOf(2).id, number: 3 }],
        },
      };
      for (const override of [
        { note: "Sudah saya periksa", versionId: s.itemOf(0).questionVersionId },
        { note: "   ", versionId },
        { versionId },
      ]) {
        await database.db
          .update(questions)
          .set({ approvalOverride: { ...override, at: NOW.toISOString() } })
          .where(eq(questions.id, s.a[2]));
        expect(await doApprove(s), JSON.stringify(override)).toEqual(refused);
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses a trashed template",
    async () => {
      const s = await seed();
      await database.db
        .update(schoolTemplates)
        .set({ deletedAt: NOW, purgeAfter: NOW })
        .where(eq(schoolTemplates.id, s.templateId));
      expect(await doApprove(s)).toEqual({
        ok: false,
        error: { code: "notReady", problems: [{ code: "trashed", template: true }] },
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses when the page saw a different snapshot (conflict)",
    async () => {
      const s = await seed();
      expect(await doApprove(s, USER_A, "0".repeat(64))).toEqual({
        ok: false,
        error: "conflict",
      });
      expect((await row(s.assessmentId)).status).toBe("draft");
      expect(await doApprove(s, USER_A, await currentHash(s))).toMatchObject({
        ok: true,
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "changes the hash when the order, the points, the seed or a printed template field changes",
    async () => {
      const s = await seed();
      const seen = new Set<string>([await currentHash(s)]);
      const expectNew = async (label: string) => {
        const hash = await currentHash(s);
        expect(seen.has(hash), label).toBe(false);
        seen.add(hash);
      };
      await asUser(USER_A, (tx) =>
        moveItem(tx, {
          ownerId: USER_A,
          itemId: s.itemOf(0).id,
          toSectionId: s.itemOf(0).sectionId,
          toIndex: 2,
        }),
      );
      await expectNew("order");
      await asUser(USER_A, (tx) =>
        setScoringMode(tx, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          mode: "manual",
        }),
      );
      await expectNew("mode");
      await asUser(USER_A, (tx) =>
        setPoints(tx, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          points: [{ itemId: s.itemOf(1).id, points: 7 }],
        }),
      );
      await expectNew("points");
      await asUser(USER_A, (tx) =>
        setShuffle(tx, { ownerId: USER_A, assessmentId: s.assessmentId, mode: "on" }),
      );
      await expectNew("seed on");
      await asUser(USER_A, (tx) =>
        setShuffle(tx, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          mode: "reshuffle",
        }),
      );
      await expectNew("reshuffle");
      await database.db
        .update(schoolTemplates)
        .set({ schoolName: "SMP 2" })
        .where(eq(schoolTemplates.id, s.templateId));
      await expectNew("template school name");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses an approved assessment and every edit while approved",
    async () => {
      const s = await seed();
      expect(await doApprove(s)).toMatchObject({ ok: true });
      expect(await doApprove(s)).toEqual({ ok: false, error: "approved" });
      const id = s.assessmentId;
      expect(
        await asUser(USER_A, (tx) =>
          setScoringMode(tx, { ownerId: USER_A, assessmentId: id, mode: "manual" }),
        ),
      ).toEqual({ ok: false, error: "approved" });
      expect(
        await asUser(USER_A, (tx) =>
          setPoints(tx, {
            ownerId: USER_A,
            assessmentId: id,
            points: [{ itemId: s.itemOf(0).id, points: 3 }],
          }),
        ),
      ).toEqual({ ok: false, error: "approved" });
      expect(
        await asUser(USER_A, (tx) =>
          setShuffle(tx, { ownerId: USER_A, assessmentId: id, mode: "on" }),
        ),
      ).toEqual({ ok: false, error: "approved" });
      expect(
        await asUser(USER_A, (tx) =>
          addSection(tx, { ownerId: USER_A, assessmentId: id, title: "C" }),
        ),
      ).toEqual({ ok: false, error: "approved" });
    },
    DB_TEST_TIMEOUT,
  );
});

describe("reopen", () => {
  it(
    "clears the approval, the hash and the status, and editing works again",
    async () => {
      const s = await seed();
      expect(await doApprove(s)).toMatchObject({ ok: true });
      const result = await asUser(USER_A, (tx) =>
        reopen(tx, { ownerId: USER_A, assessmentId: s.assessmentId }),
      );
      expect(result).toEqual({ ok: true, data: { reopened: true } });
      const stored = await row(s.assessmentId);
      expect(stored.status).toBe("draft");
      expect(stored.approvedAt).toBeNull();
      expect(stored.approvedSnapshotHash).toBeNull();
      expect(await valid(s)).toBe(false);
      expect(
        await asUser(USER_A, (tx) =>
          addSection(tx, { ownerId: USER_A, assessmentId: s.assessmentId, title: "C" }),
        ),
      ).toMatchObject({ ok: true });
      // Reopening a draft changes nothing.
      expect(
        await asUser(USER_A, (tx) =>
          reopen(tx, { ownerId: USER_A, assessmentId: s.assessmentId }),
        ),
      ).toEqual({ ok: true, data: { reopened: false } });
    },
    DB_TEST_TIMEOUT,
  );
});

describe("the export gate (isApprovedAndValid)", () => {
  it(
    "is false for a status the client wrote directly with a hash that does not match",
    async () => {
      const s = await seed();
      // A forged approval with a made-up hash.
      await database.db
        .update(assessments)
        .set({
          status: "approved",
          approvedAt: NOW,
          approvedSnapshotHash: "f".repeat(64),
        })
        .where(eq(assessments.id, s.assessmentId));
      expect(await valid(s)).toBe(false);
      const forged = await asUser(USER_A, (tx) =>
        getApprovalState(tx, { ownerId: USER_A, assessmentId: s.assessmentId }),
      );
      expect(forged?.approved).toBe(true);
      expect(forged?.stale).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "goes stale when the template changes after approval; a later trash keeps the pinned paper exportable",
    async () => {
      const s = await seed();
      expect(await doApprove(s)).toMatchObject({ ok: true });
      expect(await valid(s)).toBe(true);
      // Trashing a pinned question after approval: the pinned version still exports (it cannot be
      // purged while pinned, Ruling R2); re-approval would be refused.
      await database.db
        .update(questions)
        .set({ deletedAt: NOW, purgeAfter: NOW })
        .where(eq(questions.id, s.a[0]));
      expect(await valid(s)).toBe(true);
      await database.db
        .update(schoolTemplates)
        .set({ font: "arial" })
        .where(eq(schoolTemplates.id, s.templateId));
      expect(await valid(s)).toBe(false);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "stays valid when the template's default flag, name or row version change, not when it prints differently (R26)",
    async () => {
      const s = await seed();
      expect(await doApprove(s)).toMatchObject({ ok: true });
      const [other] = await database.db
        .insert(schoolTemplates)
        .values({ ownerId: USER_A, name: "Lain", schoolName: "SMP 9", isDefault: true })
        .returning({ id: schoolTemplates.id });
      // Switching the default bumps the row version of both templates.
      for (const templateId of [s.templateId, other.id]) {
        expect(
          await asUser(USER_A, (tx) =>
            setDefaultTemplate(tx as never, { ownerId: USER_A, templateId }),
          ),
        ).toMatchObject({ ok: true });
      }
      await database.db
        .update(schoolTemplates)
        .set({ name: "Nama baru", rowVersion: sql`${schoolTemplates.rowVersion} + 7` })
        .where(eq(schoolTemplates.id, s.templateId));
      expect(await valid(s)).toBe(true);

      const [before] = await database.db
        .select()
        .from(schoolTemplates)
        .where(eq(schoolTemplates.id, s.templateId));
      const printed: Partial<typeof schoolTemplates.$inferInsert>[] = [
        { schoolName: "SMP 2" },
        { headerLines: ["BARIS BARU"] },
        { subject: "IPA" },
        { studentFields: ["name", "class", "number"] },
        { defaultInstructionsMd: "Kerjakan sendiri." },
        { paperSize: "F4" },
        { font: "arial" },
        { logoKey: `templates/${USER_A}/${s.templateId}/logo.png` },
        // The same key with a content hash (a replaced logo): computeSnapshotHash tests above.
        {
          logoKey: `templates/${USER_A}/${s.templateId}/logo.png`,
          logoSha256: "c".repeat(64),
        },
      ];
      for (const change of printed) {
        await database.db
          .update(schoolTemplates)
          .set(change)
          .where(eq(schoolTemplates.id, s.templateId));
        expect(await valid(s), JSON.stringify(change)).toBe(false);
        await database.db
          .update(schoolTemplates)
          .set({
            schoolName: before.schoolName,
            headerLines: before.headerLines,
            subject: before.subject,
            studentFields: before.studentFields,
            defaultInstructionsMd: before.defaultInstructionsMd,
            paperSize: before.paperSize,
            font: before.font,
            logoKey: before.logoKey,
            logoSha256: before.logoSha256,
          })
          .where(eq(schoolTemplates.id, s.templateId));
        expect(await valid(s), `restored ${JSON.stringify(change)}`).toBe(true);
      }
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "keeps an approved paper valid when its questions are edited, sent back to draft, lose their override or get a mismatch (R11)",
    async () => {
      const s = await seed();
      // Question 3 pins a mismatch version the teacher approved with a note.
      const overridden = s.itemOf(2).questionVersionId;
      await database.db.insert(verificationRuns).values({
        ownerId: USER_A,
        questionVersionId: overridden,
        verifierVersion: "test",
        status: "ketidaksesuaian",
      });
      await database.db
        .update(questions)
        .set({
          approvalOverride: {
            note: "Sudah saya periksa",
            versionId: overridden,
            at: NOW.toISOString(),
          },
        })
        .where(eq(questions.id, s.a[2]));
      expect(await doApprove(s)).toMatchObject({ ok: true });

      // A clean edit: the question's approval moves to its new version.
      await editBanked(s.a[0]);
      // A mismatch edit sends a question back to review.
      await database.db
        .update(questions)
        .set({
          status: "draft",
          approvedVersionId: null,
          approvedAt: null,
          bankedAt: null,
        })
        .where(eq(questions.id, s.a[1]));
      // Any later edit clears the override.
      await database.db
        .update(questions)
        .set({ approvalOverride: null })
        .where(eq(questions.id, s.a[2]));
      // A late verification run on a pinned version.
      await database.db.insert(verificationRuns).values({
        ownerId: USER_A,
        questionVersionId: s.itemOf(3).questionVersionId,
        verifierVersion: "test",
        status: "ketidaksesuaian",
      });
      expect(await valid(s)).toBe(true);
      const state = await asUser(USER_A, (tx) =>
        getApprovalState(tx, { ownerId: USER_A, assessmentId: s.assessmentId }),
      );
      expect(state?.stale).toBe(false);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "goes stale when a pinned version id is rewritten directly (R12)",
    async () => {
      const s = await seed();
      expect(await doApprove(s)).toMatchObject({ ok: true });
      await editBanked(s.a[0]);
      const [question] = await database.db
        .select()
        .from(questions)
        .where(eq(questions.id, s.a[0]));
      await database.db
        .update(assessmentItems)
        .set({ questionVersionId: question.currentVersionId ?? "" })
        .where(eq(assessmentItems.id, s.itemOf(0).id));
      expect(await valid(s)).toBe(false);
      expect(
        await verifyApproval(db(), { ownerId: USER_A, assessmentId: s.assessmentId }),
      ).toEqual({ ok: false, error: "stale" });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "goes stale when a pinned version is gone (the foreign key normally prevents it)",
    async () => {
      const s = await seed();
      expect(await doApprove(s)).toMatchObject({ ok: true });
      await editBanked(s.a[0]); // the pinned version is now neither current nor approved
      // Bypass the foreign keys and the immutability trigger for this one statement.
      await database.db.transaction(async (tx) => {
        await tx.execute(sql`set local session_replication_role = replica`);
        const versionId = s.itemOf(0).questionVersionId;
        // Its dependants go too (the cascades do not run in replica mode).
        await tx
          .delete(questionSources)
          .where(eq(questionSources.questionVersionId, versionId));
        await tx
          .delete(verificationRuns)
          .where(eq(verificationRuns.questionVersionId, versionId));
        await tx.delete(questionVersions).where(eq(questionVersions.id, versionId));
      });
      expect(
        await verifyApproval(db(), { ownerId: USER_A, assessmentId: s.assessmentId }),
      ).toEqual({ ok: false, error: "stale" });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "re-approval re-checks everything: a pin that is no longer the approved version is refused",
    async () => {
      const s = await seed();
      expect(await doApprove(s)).toMatchObject({ ok: true });
      await editBanked(s.a[0]);
      await database.db
        .update(questions)
        .set({
          status: "draft",
          approvedVersionId: null,
          approvedAt: null,
          bankedAt: null,
        })
        .where(eq(questions.id, s.a[1]));
      expect(
        await asUser(USER_A, (tx) =>
          reopen(tx, { ownerId: USER_A, assessmentId: s.assessmentId }),
        ),
      ).toMatchObject({ ok: true });
      expect(await doApprove(s)).toEqual({
        ok: false,
        error: {
          code: "notReady",
          problems: [
            { code: "notApproved", itemId: s.itemOf(0).id, number: 1 },
            { code: "notApproved", itemId: s.itemOf(1).id, number: 2 },
          ],
        },
      });
    },
    DB_TEST_TIMEOUT,
  );
});

describe("cross-user isolation", () => {
  it(
    "another teacher can neither approve, reopen, read the state nor pass the gate",
    async () => {
      const s = await seed();
      expect(await doApprove(s, USER_B)).toEqual({ ok: false, error: "notFound" });
      expect((await row(s.assessmentId)).status).toBe("draft");
      expect(await doApprove(s)).toMatchObject({ ok: true });
      expect(
        await asUser(USER_B, (tx) =>
          reopen(tx, { ownerId: USER_B, assessmentId: s.assessmentId }),
        ),
      ).toEqual({ ok: false, error: "notFound" });
      expect((await row(s.assessmentId)).status).toBe("approved");
      expect(
        await asUser(USER_B, (tx) =>
          getApprovalState(tx, { ownerId: USER_B, assessmentId: s.assessmentId }),
        ),
      ).toBeNull();
      expect(await valid(s, USER_B)).toBe(false);
      expect(
        await loadSnapshot(db(), { ownerId: USER_B, assessmentId: s.assessmentId }),
      ).toBeNull();
      expect(
        await asUser(USER_A, (tx) =>
          reopen(tx, { ownerId: USER_A, assessmentId: "not-a-uuid" }),
        ),
      ).toEqual({ ok: false, error: "notFound" });
    },
    DB_TEST_TIMEOUT,
  );
});
