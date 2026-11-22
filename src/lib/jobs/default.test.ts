import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jobs } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createJobQueue } from "./queue";

// runDefaultJobs reads the service connection through getDb(); point it at the test database.
const holder = vi.hoisted((): { db: unknown } => ({ db: undefined }));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => holder.db }));

import { runDefaultJobs } from "./default";

// USER_A is a@example.test and USER_B is b@example.test (the harness seed). The list variable is
// not named here; ADMIN_EMAIL stands in for "approved".
let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  holder.db = t.db;
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await t.client.close();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runDefaultJobs approval wiring", () => {
  it("fails the job of an owner who is not approved as account_not_approved", async () => {
    vi.stubEnv("ADMIN_EMAIL", "a@example.test");
    const queue = createJobQueue(t.db);
    const refused = await queue.enqueue({ ownerId: USER_B, type: "no_such_type" });
    const summary = await runDefaultJobs();
    const [row] = await t.db.select().from(jobs).where(eq(jobs.id, refused.id));
    expect(row).toMatchObject({
      status: "failed",
      error: { code: "account_not_approved" },
    });
    expect(summary.failed).toBeGreaterThanOrEqual(1);
  });
});
