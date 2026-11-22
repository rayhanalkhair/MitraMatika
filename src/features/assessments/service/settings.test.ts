import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAsUser } from "@/lib/db/client";
import { assessmentItems, assessments } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { seedCurriculum } from "@/features/generation";
import { ASSESSMENT_INPUT, clearAll, seedBankedQuestions } from "../test-support";
import { createAssessment, type AssessmentDb } from "./assessments";
import { addItems } from "./items";
import { setPoints, setScoringMode, setShuffle } from "./settings";

let database: TestDatabase;
const db = () => database.db as unknown as AssessmentDb;
const NOW = new Date("2026-11-10T10:00:00.000Z");

const asUser = <T>(userId: string, fn: (tx: AssessmentDb) => Promise<T>) =>
  runAsUser(db(), userId, (tx) => fn(tx as unknown as AssessmentDb));

async function seed() {
  const curriculum = await seedCurriculum(database.db);
  const a = await seedBankedQuestions(database, {
    ownerId: USER_A,
    count: 3,
    curriculum,
  });
  const created = await asUser(USER_A, async (tx) => {
    const result = await createAssessment(tx, {
      ownerId: USER_A,
      input: ASSESSMENT_INPUT,
    });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  });
  await asUser(USER_A, (tx) =>
    addItems(tx, {
      ownerId: USER_A,
      assessmentId: created.id,
      sectionId: created.sectionId,
      questionIds: a,
    }),
  );
  const itemIds = (
    await database.db
      .select({ id: assessmentItems.id })
      .from(assessmentItems)
      .where(eq(assessmentItems.assessmentId, created.id))
      .orderBy(asc(assessmentItems.sortOrder))
  ).map((row) => row.id);
  return { assessmentId: created.id, itemIds };
}

const row = async (assessmentId: string) =>
  (
    await database.db.select().from(assessments).where(eq(assessments.id, assessmentId))
  )[0];

const pointsOf = async (assessmentId: string) =>
  (
    await database.db
      .select({ points: assessmentItems.points })
      .from(assessmentItems)
      .where(eq(assessmentItems.assessmentId, assessmentId))
      .orderBy(asc(assessmentItems.sortOrder))
  ).map((r) => Number(r.points));

const approveDirectly = (assessmentId: string) =>
  database.db
    .update(assessments)
    .set({ status: "approved", approvedAt: NOW, approvedSnapshotHash: "h" })
    .where(eq(assessments.id, assessmentId));

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await clearAll(database);
});

describe("setScoringMode", () => {
  it("switches the mode", async () => {
    const s = await seed();
    for (const mode of ["manual", "normalised", "equal"] as const) {
      const result = await asUser(USER_A, (tx) =>
        setScoringMode(tx, { ownerId: USER_A, assessmentId: s.assessmentId, mode }),
      );
      expect(result).toEqual({ ok: true, data: undefined });
      expect((await row(s.assessmentId)).scoringMode).toBe(mode);
    }
  });

  it(
    "is refused while approved and notFound for another teacher",
    async () => {
      const s = await seed();
      expect(
        await asUser(USER_B, (tx) =>
          setScoringMode(tx, {
            ownerId: USER_B,
            assessmentId: s.assessmentId,
            mode: "manual",
          }),
        ),
      ).toEqual({ ok: false, error: "notFound" });
      await approveDirectly(s.assessmentId);
      expect(
        await asUser(USER_A, (tx) =>
          setScoringMode(tx, {
            ownerId: USER_A,
            assessmentId: s.assessmentId,
            mode: "manual",
          }),
        ),
      ).toEqual({ ok: false, error: "approved" });
      expect((await row(s.assessmentId)).scoringMode).toBe("equal");
    },
    DB_TEST_TIMEOUT,
  );
});

describe("setPoints", () => {
  it("stores the points of the named items in one call", async () => {
    const s = await seed();
    const result = await asUser(USER_A, (tx) =>
      setPoints(tx, {
        ownerId: USER_A,
        assessmentId: s.assessmentId,
        points: [
          { itemId: s.itemIds[0], points: 2.5 },
          { itemId: s.itemIds[2], points: 10 },
        ],
      }),
    );
    expect(result).toEqual({ ok: true, data: { changed: 2 } });
    expect(await pointsOf(s.assessmentId)).toEqual([2.5, 0, 10]);
  });

  it("refuses zero, negative, too precise and too large points, and a repeated item, changing nothing", async () => {
    const s = await seed();
    for (const points of [0, -1, 1.234, 1000.01, Number.NaN]) {
      expect(
        await asUser(USER_A, (tx) =>
          setPoints(tx, {
            ownerId: USER_A,
            assessmentId: s.assessmentId,
            points: [
              { itemId: s.itemIds[0], points: 5 },
              { itemId: s.itemIds[1], points },
            ],
          }),
        ),
        String(points),
      ).toEqual({ ok: false, error: "invalidPoints" });
    }
    expect(
      await asUser(USER_A, (tx) =>
        setPoints(tx, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          points: [
            { itemId: s.itemIds[0], points: 5 },
            { itemId: s.itemIds[0], points: 6 },
          ],
        }),
      ),
    ).toEqual({ ok: false, error: "invalid" });
    expect(await pointsOf(s.assessmentId)).toEqual([0, 0, 0]);
  });

  it(
    "refuses an item of another assessment or teacher, or a malformed id, changing nothing",
    async () => {
      const s = await seed();
      const other = await asUser(USER_A, async (tx) => {
        const result = await createAssessment(tx, {
          ownerId: USER_A,
          input: ASSESSMENT_INPUT,
        });
        if (!result.ok) throw new Error(result.error);
        return result.data.id;
      });
      for (const assessmentId of [other]) {
        expect(
          await asUser(USER_A, (tx) =>
            setPoints(tx, {
              ownerId: USER_A,
              assessmentId,
              points: [{ itemId: s.itemIds[0], points: 5 }],
            }),
          ),
        ).toEqual({ ok: false, error: "itemNotFound" });
      }
      expect(
        await asUser(USER_A, (tx) =>
          setPoints(tx, {
            ownerId: USER_A,
            assessmentId: s.assessmentId,
            points: [{ itemId: "nope", points: 5 }],
          }),
        ),
      ).toEqual({ ok: false, error: "itemNotFound" });
      expect(
        await asUser(USER_B, (tx) =>
          setPoints(tx, {
            ownerId: USER_B,
            assessmentId: s.assessmentId,
            points: [{ itemId: s.itemIds[0], points: 5 }],
          }),
        ),
      ).toEqual({ ok: false, error: "notFound" });
      expect(await pointsOf(s.assessmentId)).toEqual([0, 0, 0]);
    },
    DB_TEST_TIMEOUT,
  );

  it("is refused while approved", async () => {
    const s = await seed();
    await approveDirectly(s.assessmentId);
    expect(
      await asUser(USER_A, (tx) =>
        setPoints(tx, {
          ownerId: USER_A,
          assessmentId: s.assessmentId,
          points: [{ itemId: s.itemIds[0], points: 5 }],
        }),
      ),
    ).toEqual({ ok: false, error: "approved" });
    expect(await pointsOf(s.assessmentId)).toEqual([0, 0, 0]);
  });
});

describe("setShuffle", () => {
  const shuffle = (
    assessmentId: string,
    mode: "on" | "off" | "reshuffle",
    owner = USER_A,
  ) => asUser(owner, (tx) => setShuffle(tx, { ownerId: owner, assessmentId, mode }));

  it("turning on stores a server-made seed; on again keeps it; reshuffle changes it; off clears it", async () => {
    const s = await seed();
    const on = await shuffle(s.assessmentId, "on");
    if (!on.ok) throw new Error(on.error);
    const seed1 = on.data.seed;
    expect(Number.isInteger(seed1)).toBe(true);
    expect((await row(s.assessmentId)).shuffleSeed).toBe(seed1);

    expect(await shuffle(s.assessmentId, "on")).toEqual({
      ok: true,
      data: { seed: seed1 },
    });

    const again = await shuffle(s.assessmentId, "reshuffle");
    if (!again.ok) throw new Error(again.error);
    expect(again.data.seed).not.toBe(seed1);
    expect((await row(s.assessmentId)).shuffleSeed).toBe(again.data.seed);

    expect(await shuffle(s.assessmentId, "off")).toEqual({
      ok: true,
      data: { seed: null },
    });
    expect((await row(s.assessmentId)).shuffleSeed).toBeNull();
  });

  it("gives different assessments different seeds", async () => {
    const s = await seed();
    const seeds = new Set<number | null>();
    for (let i = 0; i < 5; i += 1) {
      const result = await shuffle(s.assessmentId, "reshuffle");
      if (!result.ok) throw new Error(result.error);
      seeds.add(result.data.seed);
    }
    expect(seeds.size).toBe(5);
  });

  it("is refused while approved and notFound for another teacher", async () => {
    const s = await seed();
    expect(await shuffle(s.assessmentId, "on", USER_B)).toEqual({
      ok: false,
      error: "notFound",
    });
    await approveDirectly(s.assessmentId);
    expect(await shuffle(s.assessmentId, "on")).toEqual({ ok: false, error: "approved" });
    expect((await row(s.assessmentId)).shuffleSeed).toBeNull();
  });
});
