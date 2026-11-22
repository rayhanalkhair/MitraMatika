import { afterEach, describe, expect, it, vi } from "vitest";
import {
  E2E_COOKIE,
  E2E_FAKE_PENDING_USER,
  E2E_FAKE_USER,
  fakeSessionUser,
  isFakeAuthEnabled,
} from "./e2e-session";
import { resolveAccess } from "./access";

afterEach(() => {
  vi.unstubAllEnvs();
});

const enable = () => {
  vi.stubEnv("E2E_FAKE_AUTH", "1");
  vi.stubEnv("NODE_ENV", "development");
};

describe("isFakeAuthEnabled", () => {
  it("is off by default", () => {
    vi.stubEnv("E2E_FAKE_AUTH", "");
    expect(isFakeAuthEnabled()).toBe(false);
  });

  it("is off when the flag is unset, whatever NODE_ENV says", () => {
    vi.stubEnv("E2E_FAKE_AUTH", undefined);
    for (const env of ["development", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      expect(isFakeAuthEnabled()).toBe(false);
    }
  });

  it("is on when the flag is 1 outside production", () => {
    enable();
    expect(isFakeAuthEnabled()).toBe(true);
  });

  it("only accepts the exact value 1", () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const value of ["true", "0", "yes", " 1"]) {
      vi.stubEnv("E2E_FAKE_AUTH", value);
      expect(isFakeAuthEnabled()).toBe(false);
    }
  });

  it("is off when NODE_ENV is unset or anything but development or test", () => {
    vi.stubEnv("E2E_FAKE_AUTH", "1");
    for (const env of [undefined, "", "staging", "preview", "Production"]) {
      vi.stubEnv("NODE_ENV", env);
      expect(isFakeAuthEnabled(), String(env)).toBe(false);
    }
    vi.stubEnv("NODE_ENV", "test");
    expect(isFakeAuthEnabled()).toBe(true);
  });

  it("is hard-disabled in production even when the flag is set", () => {
    vi.stubEnv("E2E_FAKE_AUTH", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect(isFakeAuthEnabled()).toBe(false);
  });
});

describe("E2E_FAKE_USER", () => {
  it("is the one fixed test identity the CI seed inserts", () => {
    expect(E2E_FAKE_USER).toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      email: "teacher@example.test",
    });
  });
});

describe("fakeSessionUser", () => {
  it("returns null when the seam is disabled, even with the test identity's cookie", () => {
    vi.stubEnv("E2E_FAKE_AUTH", "");
    expect(fakeSessionUser(E2E_FAKE_USER.email)).toBeNull();
  });

  it("returns null in production even with the flag and the test identity's cookie", () => {
    vi.stubEnv("E2E_FAKE_AUTH", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect(fakeSessionUser(E2E_FAKE_USER.email)).toBeNull();
  });

  it("returns null when there is no cookie value", () => {
    enable();
    expect(fakeSessionUser(undefined)).toBeNull();
    expect(fakeSessionUser("")).toBeNull();
  });

  it("returns the fixed test identity for its exact email when enabled", () => {
    enable();
    expect(fakeSessionUser("teacher@example.test")).toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      email: "teacher@example.test",
    });
  });

  it("rejects every other cookie value, including near variants of the test email", () => {
    enable();
    for (const value of [
      "stranger@example.test",
      "admin@mitramatika.id",
      "TEACHER@example.test",
      " teacher@example.test",
      "teacher@example.test ",
      "teacher@example.test\u0000",
      E2E_FAKE_USER.id,
      "x".repeat(500),
    ]) {
      expect(fakeSessionUser(value), JSON.stringify(value)).toBeNull();
    }
  });
});

it("uses the cookie name the Playwright helper sets", () => {
  expect(E2E_COOKIE).toBe("e2e-user");
});

describe("E2E_FAKE_PENDING_USER", () => {
  it("is a second fixed identity with its own id", () => {
    expect(E2E_FAKE_PENDING_USER).toEqual({
      id: "00000000-0000-4000-8000-000000000002",
      email: "pending@example.test",
    });
    expect(E2E_FAKE_PENDING_USER.id).not.toBe(E2E_FAKE_USER.id);
  });

  it("is accepted by its exact cookie value only, and only when the seam is on", () => {
    enable();
    const user = fakeSessionUser("pending@example.test");
    expect(user).toMatchObject({
      id: E2E_FAKE_PENDING_USER.id,
      email: E2E_FAKE_PENDING_USER.email,
    });
    expect(user?.sessionCreatedAt).toBeInstanceOf(Date);
    for (const value of [
      "PENDING@example.test",
      " pending@example.test",
      "pending@example.test ",
      "pending@example.test\u0000",
      "other@example.test",
    ]) {
      expect(fakeSessionUser(value), JSON.stringify(value)).toBeNull();
    }
    vi.stubEnv("E2E_FAKE_AUTH", "");
    expect(fakeSessionUser("pending@example.test")).toBeNull();
    vi.stubEnv("E2E_FAKE_AUTH", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect(fakeSessionUser("pending@example.test")).toBeNull();
  });

  it("is never approved by the seam itself: it carries no approval, the environment decides", () => {
    enable();
    vi.stubEnv("ADMIN_EMAIL", "teacher@example.test");
    const user = fakeSessionUser("pending@example.test");
    expect(resolveAccess(user).status).toBe("pending");
    expect(resolveAccess(fakeSessionUser("teacher@example.test")).status).toBe("allowed");
    expect(Object.keys(user ?? {})).not.toContain("status");
  });
});
