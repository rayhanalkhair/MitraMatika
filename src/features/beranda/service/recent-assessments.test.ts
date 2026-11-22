import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assessments } from "@/lib/db/schema";
import { runAsUser } from "@/lib/db/client";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import type { AnyDb } from "@/features/generation";
import { getRecentAssessments } from "./recent-assessments";

let database: TestDatabase;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 3, minute));

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await database.db.delete(assessments);
});

async function seed(
  ownerId: string,
  title: string,
  updatedAt: Date,
  over: Partial<typeof assessments.$inferInsert> = {},
) {
  await database.db.insert(assessments).values({
    ownerId,
    title,
    grade: 8,
    updatedAt,
    createdAt: at(0),
    ...over,
  });
}

const recent = (userId: string) =>
  runAsUser(database.db as unknown as AnyDb, userId, (tx) =>
    getRecentAssessments(tx as unknown as AnyDb, { ownerId: userId }),
  );

describe("getRecentAssessments", () => {
  it(
    "lists the teacher's three most recently changed assessments, trashed ones left out",
    async () => {
      await seed(USER_A, "Satu", at(1));
      await seed(USER_A, "Dua", at(2), {
        status: "approved",
        approvedAt: at(2),
        approvedSnapshotHash: "a".repeat(64),
      });
      await seed(USER_A, "Tiga", at(3));
      await seed(USER_A, "Empat", at(4));
      await seed(USER_A, "Di sampah", at(5), { deletedAt: at(5), purgeAfter: at(6) });
      await seed(USER_B, "Milik B", at(9));

      const list = await recent(USER_A);
      expect(list.map((item) => item.title)).toEqual(["Empat", "Tiga", "Dua"]);
      expect(list[2]).toMatchObject({
        status: "approved",
        updatedAt: at(2).toISOString(),
      });
      expect(list[0].status).toBe("draft");
      expect(list[0].id).toMatch(/^[0-9a-f-]{36}$/);
      expect((await recent(USER_B)).map((item) => item.title)).toEqual(["Milik B"]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "is empty for a teacher without assessments",
    async () => {
      expect(await recent(USER_A)).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
});
