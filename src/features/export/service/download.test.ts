import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assessments, exports } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { err, ok } from "@/lib/result";
import { clearAll } from "@/features/assessments/test-support";
import {
  reapproveChanged,
  recordingStore,
  seedApprovedAssessment,
} from "../db-test-support";
import { handleExportDownload, type DownloadDeps } from "./download";

let database: TestDatabase;
const NOW = new Date("2026-11-20T03:00:00.000Z");
const DAY = 86_400_000;

const signedIn = (userId: string) => () =>
  Promise.resolve(
    ok({ status: "allowed", userId, email: "x@example.test", displayName: null }),
  ) as unknown as ReturnType<DownloadDeps["authorize"]>;

async function seedExport(input: {
  title?: string;
  expiresAt?: Date;
  document?: string;
  format?: string;
}) {
  const seeded = await seedApprovedAssessment(database, {
    ownerId: USER_A,
    title: input.title ?? "Ulangan Bab 1: Bilangan Bulat",
  });
  const [row] = await database.db
    .insert(exports)
    .values({
      ownerId: USER_A,
      assessmentId: seeded.assessmentId,
      document: input.document ?? "paper",
      format: input.format ?? "pdf",
      objectKey: `exports/${USER_A}/33333333-3333-4333-8333-333333333333/paper.pdf`,
      snapshotHash: seeded.hash,
      expiresAt: input.expiresAt ?? new Date(NOW.getTime() + 7 * DAY),
    })
    .returning();
  return { ...seeded, exportId: row.id };
}

function deps(userId: string, over: Partial<DownloadDeps> = {}): DownloadDeps {
  const store = recordingStore();
  return {
    authorize: signedIn(userId),
    db: database.db,
    store: () => store,
    now: () => NOW,
    ...over,
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  await clearAll(database);
});

describe("GET /api/exports/[id]", () => {
  it(
    "redirects the owner to a 300 s signed URL that downloads under a name from the title",
    async () => {
      const { exportId } = await seedExport({});
      const response = await handleExportDownload(exportId, deps(USER_A));
      expect(response.status).toBe(302);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.pathname).toBe(
        `/exports/${USER_A}/33333333-3333-4333-8333-333333333333/paper.pdf`,
      );
      expect(location.searchParams.get("expires")).toBe("300");
      expect(location.searchParams.get("download")).toBe(
        "ulangan-bab-1-bilangan-bulat-naskah-soal.pdf",
      );
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "names the ZIP after the title alone and strips accents and symbols",
    async () => {
      const { exportId } = await seedExport({
        title: "Latihan Éxponen & Akar ✓",
        document: "zip",
        format: "zip",
      });
      const response = await handleExportDownload(exportId, deps(USER_A));
      expect(
        new URL(response.headers.get("location") ?? "").searchParams.get("download"),
      ).toBe("latihan-exponen-akar.zip");
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "answers 404 for another teacher, an unknown id and a malformed id, and signs nothing",
    async () => {
      const { exportId } = await seedExport({});
      const store = recordingStore();
      const sign = vi.spyOn(store, "signedGetUrl");
      for (const [user, id] of [
        [USER_B, exportId],
        [USER_A, "99999999-9999-4999-8999-999999999999"],
        [USER_A, "not-a-uuid"],
      ] as const) {
        const response = await handleExportDownload(
          id,
          deps(user, { store: () => store }),
        );
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      expect(sign).not.toHaveBeenCalled();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "answers 404 once the assessment is in the trash",
    async () => {
      const { exportId, assessmentId } = await seedExport({});
      await database.db
        .update(assessments)
        .set({ deletedAt: NOW, purgeAfter: new Date(NOW.getTime() + 30 * DAY) })
        .where(eq(assessments.id, assessmentId));
      expect((await handleExportDownload(exportId, deps(USER_A))).status).toBe(404);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "answers 410 after the expiry, also before the purge has removed the row",
    async () => {
      const { exportId } = await seedExport({ expiresAt: NOW });
      const response = await handleExportDownload(exportId, deps(USER_A));
      expect(response.status).toBe(410);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("location")).toBeNull();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "answers 410 for a file of an earlier approval after reopen, change and approve (R27)",
    async () => {
      const { exportId, assessmentId } = await seedExport({});
      const store = recordingStore();
      const sign = vi.spyOn(store, "signedGetUrl");
      await reapproveChanged(database, { ownerId: USER_A, assessmentId });
      const response = await handleExportDownload(
        exportId,
        deps(USER_A, { store: () => store }),
      );
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error: "superseded" });
      expect(response.headers.get("location")).toBeNull();
      expect(sign).not.toHaveBeenCalled();
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "answers 410 while the assessment is reopened (no approval to match)",
    async () => {
      const { exportId, assessmentId } = await seedExport({});
      await database.db
        .update(assessments)
        .set({ status: "draft", approvedAt: null, approvedSnapshotHash: null })
        .where(eq(assessments.id, assessmentId));
      expect((await handleExportDownload(exportId, deps(USER_A))).status).toBe(410);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "answers 401 without a session",
    async () => {
      const { exportId } = await seedExport({});
      const response = await handleExportDownload(
        exportId,
        deps(USER_A, {
          authorize: () => Promise.resolve(err("unauthenticated")),
        }),
      );
      expect(response.status).toBe(401);
    },
    DB_TEST_TIMEOUT,
  );
});
