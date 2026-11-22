import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { user } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { isOwnerApproved } from "./owner-approval";

// The list variable is read only by approval.ts (its own tests cover it); these use ADMIN_EMAIL.
// USER_A is a@example.test and USER_B is b@example.test (the harness seed).
let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await t.client.close();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isOwnerApproved", () => {
  it("is true for an approved address (ADMIN_EMAIL is always approved, any case)", async () => {
    vi.stubEnv("ADMIN_EMAIL", "A@Example.test");
    expect(await isOwnerApproved(USER_A, t.db)).toBe(true);
  });

  it("is false for an owner whose address is not approved", async () => {
    vi.stubEnv("ADMIN_EMAIL", "a@example.test");
    expect(await isOwnerApproved(USER_B, t.db)).toBe(false);
  });

  it("is false when nothing is configured", async () => {
    vi.stubEnv("ADMIN_EMAIL", "");
    expect(await isOwnerApproved(USER_A, t.db)).toBe(false);
  });

  it("reads the environment on every call (an address removed later is refused)", async () => {
    vi.stubEnv("ADMIN_EMAIL", "a@example.test");
    expect(await isOwnerApproved(USER_A, t.db)).toBe(true);
    vi.stubEnv("ADMIN_EMAIL", "b@example.test");
    expect(await isOwnerApproved(USER_A, t.db)).toBe(false);
    expect(await isOwnerApproved(USER_B, t.db)).toBe(true);
  });

  it("is false for a user that does not exist (deleted account)", async () => {
    vi.stubEnv("ADMIN_EMAIL", "ghost@example.test");
    expect(await isOwnerApproved("33333333-3333-3333-3333-333333333333", t.db)).toBe(
      false,
    );
  });

  it("is false for an address that is not verified, even when listed", async () => {
    const [row] = await t.db
      .insert(user)
      .values({ name: "Squatter", email: "squat@example.test", emailVerified: false })
      .returning({ id: user.id });
    vi.stubEnv("ADMIN_EMAIL", "squat@example.test");
    expect(await isOwnerApproved(row.id, t.db)).toBe(false);
    await t.db.execute(sql`update "user" set email_verified = true where id = ${row.id}`);
    expect(await isOwnerApproved(row.id, t.db)).toBe(true);
    await t.db.execute(sql`delete from "user" where id = ${row.id}`);
  });
});
