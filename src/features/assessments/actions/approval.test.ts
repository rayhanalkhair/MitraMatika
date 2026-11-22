import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  revalidatePath: vi.fn(),
  holder: { db: {} },
}));

vi.mock("@/features/auth/service/guard", () => ({
  authorizeAction: mocks.authorizeAction,
}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => mocks.holder.db }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { seedCurriculum } from "@/features/generation";
import { runAsUser } from "@/lib/db/client";
import { assessmentItems, assessments } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { getApprovalState } from "../service/approval";
import { createAssessment, type AssessmentDb } from "../service/assessments";
import { addItems } from "../service/items";
import { ASSESSMENT_INPUT, clearAll, seedBankedQuestions } from "../test-support";
import { approveAction, reopenAction } from "./approval";
import { setPointsAction, setScoringModeAction, setShuffleAction } from "./scoring";

let database: TestDatabase;
const signIn = (userId: string) =>
  mocks.authorizeAction.mockResolvedValue({
    ok: true,
    data: { status: "allowed", userId, email: "t@example.test", displayName: null },
  });

async function seed() {
  const curriculum = await seedCurriculum(database.db);
  const a = await seedBankedQuestions(database, {
    ownerId: USER_A,
    count: 2,
    curriculum,
  });
  const db = database.db as unknown as AssessmentDb;
  const created = await runAsUser(db, USER_A, async (tx) => {
    const t = tx as unknown as AssessmentDb;
    const result = await createAssessment(t, {
      ownerId: USER_A,
      input: ASSESSMENT_INPUT,
    });
    if (!result.ok) throw new Error(result.error);
    await addItems(t, {
      ownerId: USER_A,
      assessmentId: result.data.id,
      sectionId: result.data.sectionId,
      questionIds: a,
    });
    return result.data;
  });
  const items = await database.db
    .select({ id: assessmentItems.id })
    .from(assessmentItems)
    .orderBy(asc(assessmentItems.sortOrder));
  const hash = async () => {
    const state = await runAsUser(db, USER_A, (tx) =>
      getApprovalState(tx as unknown as AssessmentDb, {
        ownerId: USER_A,
        assessmentId: created.id,
      }),
    );
    if (!state) throw new Error("no state");
    return state.hash;
  };
  return { assessmentId: created.id, itemIds: items.map((row) => row.id), hash };
}

const row = async (id: string) =>
  (await database.db.select().from(assessments).where(eq(assessments.id, id)))[0];

beforeAll(async () => {
  database = await createTestDatabase();
  mocks.holder.db = database.db;
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await clearAll(database);
  signIn(USER_A);
});

describe("the scoring and approval actions", () => {
  it(
    "set the mode, points and shuffle, approve with the hash seen, and reopen",
    async () => {
      const s = await seed();
      const id = s.assessmentId;
      expect(await setScoringModeAction({ assessmentId: id, mode: "manual" })).toEqual({
        ok: true,
      });
      expect(
        await setPointsAction({
          assessmentId: id,
          points: { [s.itemIds[0]]: "2,5", [s.itemIds[1]]: "4" },
        }),
      ).toEqual({ ok: true });
      expect(await setShuffleAction({ assessmentId: id, mode: "on" })).toEqual({
        ok: true,
      });
      expect((await row(id)).shuffleSeed).not.toBeNull();
      expect(
        await approveAction({ assessmentId: id, expectedHash: await s.hash() }),
      ).toEqual({
        ok: true,
      });
      expect((await row(id)).status).toBe("approved");
      expect(await setShuffleAction({ assessmentId: id, mode: "off" })).toEqual({
        ok: false,
        reason: "approved",
      });
      expect(await reopenAction({ assessmentId: id })).toEqual({ ok: true });
      expect((await row(id)).status).toBe("draft");
      expect(mocks.revalidatePath).toHaveBeenCalled();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "returns every problem with notReady",
    async () => {
      const s = await seed();
      await setScoringModeAction({ assessmentId: s.assessmentId, mode: "normalised" });
      const result = await approveAction({
        assessmentId: s.assessmentId,
        expectedHash: await s.hash(),
      });
      expect(result).toEqual({
        ok: false,
        reason: "notReady",
        problems: [
          {
            code: "badTotal",
            mode: "normalised",
            total: 0,
            unscored: [
              { itemId: s.itemIds[0], number: 1 },
              { itemId: s.itemIds[1], number: 2 },
            ],
          },
        ],
      });
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "validates input before the database",
    async () => {
      const s = await seed();
      const id = s.assessmentId;
      const invalid = { ok: false, reason: "invalid" };
      expect(
        await setScoringModeAction({ assessmentId: id, mode: "x" as never }),
      ).toEqual(invalid);
      expect(await setScoringModeAction(null as never)).toEqual(invalid);
      expect(await setShuffleAction({ assessmentId: id, mode: "x" as never })).toEqual(
        invalid,
      );
      expect(await approveAction({ assessmentId: id, expectedHash: "abc" })).toEqual(
        invalid,
      );
      expect(await reopenAction({ assessmentId: "nope" })).toEqual(invalid);
      expect(
        await setPointsAction({
          assessmentId: id,
          points: { nope: "1" },
        }),
      ).toEqual(invalid);
      // Only the strings the form holds: a number or a list is not points.
      expect(
        await setPointsAction({
          assessmentId: id,
          points: { [s.itemIds[0]]: 3 as never },
        }),
      ).toEqual(invalid);
      expect(await setPointsAction({ assessmentId: id, points: [] as never })).toEqual(
        invalid,
      );
      expect(
        await setPointsAction({
          assessmentId: id,
          points: { [s.itemIds[0]]: "0" },
        }),
      ).toEqual({ ok: false, reason: "invalidPoints" });
      expect(mocks.authorizeAction).not.toHaveBeenCalled();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "refuses a signed-out caller and another teacher, changing nothing",
    async () => {
      const s = await seed();
      const id = s.assessmentId;
      const hash = await s.hash();
      const all = () =>
        Promise.all([
          setScoringModeAction({ assessmentId: id, mode: "manual" }),
          setPointsAction({
            assessmentId: id,
            points: { [s.itemIds[0]]: "3" },
          }),
          setShuffleAction({ assessmentId: id, mode: "on" }),
          approveAction({ assessmentId: id, expectedHash: hash }),
          reopenAction({ assessmentId: id }),
        ]);
      mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
      for (const result of await all()) {
        expect(result).toEqual({ ok: false, reason: "unauthenticated" });
      }
      signIn(USER_B);
      for (const result of await all()) {
        expect(result).toEqual({ ok: false, reason: "notFound" });
      }
      const stored = await row(id);
      expect(stored.scoringMode).toBe("equal");
      expect(stored.shuffleSeed).toBeNull();
      expect(stored.status).toBe("draft");
    },
    DB_TEST_TIMEOUT,
  );
});
