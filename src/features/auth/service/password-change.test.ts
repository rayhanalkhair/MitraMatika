import { afterEach, describe, expect, it, vi } from "vitest";
import { verification } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
} from "@/lib/db/test-harness";
import type { AuthPortError } from "./auth-port";
import { createFakeAuthPort } from "./fake-port";
import {
  changePasswordFor,
  createPasswordAttemptLimiter,
  PASSWORD_CHANGE_ATTEMPTS,
  PASSWORD_CHANGE_WINDOW_SECONDS,
} from "./password-change";

const SECRET = "test-secret-".padEnd(40, "x");
const INPUT = { currentPassword: "lama12345", newPassword: "baru12345" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("per-user password change attempts", () => {
  it(
    "allows 5 attempts per user in 15 minutes, per user, and stores no plain user id",
    async () => {
      const t = await createTestDatabase();
      let clock = Date.parse("2026-11-17T08:00:00Z");
      const limiter = createPasswordAttemptLimiter(t.db, SECRET, () => new Date(clock));
      expect(PASSWORD_CHANGE_ATTEMPTS).toBe(5);
      expect(PASSWORD_CHANGE_WINDOW_SECONDS).toBe(900);

      const results: boolean[] = [];
      for (let i = 0; i < 6; i += 1) results.push(await limiter.allow(USER_A));
      expect(results).toEqual([true, true, true, true, true, false]);
      // Another user has a budget of their own.
      expect(await limiter.allow(USER_B)).toBe(true);

      const rows = await t.db.select().from(verification);
      expect(JSON.stringify(rows)).not.toContain(USER_A);
      expect(JSON.stringify(rows)).not.toContain(USER_B);

      // The window slides: 15 minutes after the first attempts, the user may try again.
      clock += PASSWORD_CHANGE_WINDOW_SECONDS * 1000 + 1;
      expect(await limiter.allow(USER_A)).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("changePasswordFor", () => {
  it("changes the password through the port, keeping this session and revoking the others", async () => {
    const port = createFakeAuthPort();
    expect(await changePasswordFor({ port }, { userId: USER_A, ...INPUT })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(port.calls).toEqual([{ method: "changePassword", args: [INPUT] }]);
  });

  it.each<[AuthPortError["code"], string]>([
    ["wrong_password", "wrongPassword"],
    ["rate_limited", "rateLimited"],
    ["invalid_input", "invalidInput"],
    ["unavailable", "generic"],
    ["invalid_credentials", "generic"],
  ])("maps the port's %s to %s", async (code, expected) => {
    const port = createFakeAuthPort({ changePassword: { error: { code } } });
    expect(await changePasswordFor({ port }, { userId: USER_A, ...INPUT })).toEqual({
      ok: false,
      error: expected,
    });
  });

  it("logs a thrown port or an unavailable Better Auth, without the user or the passwords, and answers generic", async () => {
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const thrown = createFakeAuthPort({ changePassword: { throws: new Error("down") } });
    expect(
      await changePasswordFor({ port: thrown }, { userId: USER_A, ...INPUT }),
    ).toEqual({ ok: false, error: "generic" });
    const unavailable = createFakeAuthPort({
      changePassword: { error: { code: "unavailable" } },
    });
    await changePasswordFor({ port: unavailable }, { userId: USER_A, ...INPUT });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toMatchObject({
      module: "settings",
      operation: "changePassword",
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/lama12345|baru12345|1111-1111/);
  });
});
