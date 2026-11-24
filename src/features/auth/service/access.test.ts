import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAccess } from "./access";
import type { SessionUser } from "./auth-port";

const approveAll = () => true;
const approveNone = () => false;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveAccess", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("treats %s as anonymous", (_label, user) => {
    expect(resolveAccess(user as SessionUser | null, approveAll)).toEqual({
      status: "anonymous",
    });
  });

  it("treats a session user without a usable id as anonymous", () => {
    expect(resolveAccess({ id: "  ", email: "guru@example.com" }, approveAll)).toEqual({
      status: "anonymous",
    });
    expect(
      resolveAccess(
        { id: 42, email: "guru@example.com" } as unknown as SessionUser,
        approveAll,
      ),
    ).toEqual({ status: "anonymous" });
  });

  it("treats a session user without a usable email as anonymous", () => {
    expect(resolveAccess({ id: "user-1", email: "" }, approveAll)).toEqual({
      status: "anonymous",
    });
    expect(
      resolveAccess({ id: "user-1", email: 7 } as unknown as SessionUser, approveAll),
    ).toEqual({ status: "anonymous" });
  });

  it("returns allowed for an approved user, with a trimmed lower-cased email", () => {
    expect(
      resolveAccess({ id: "user-2", email: " Stranger@Example.com " }, approveAll),
    ).toEqual({
      status: "allowed",
      userId: "user-2",
      email: "stranger@example.com",
      displayName: null,
    });
  });

  it("returns pending, with the same fields, for a user that is not approved", () => {
    expect(
      resolveAccess({ id: "user-2", email: " Stranger@Example.com " }, approveNone),
    ).toEqual({
      status: "pending",
      userId: "user-2",
      email: "stranger@example.com",
      displayName: null,
    });
  });

  it("hands the normalised email to the predicate", () => {
    const isApproved = vi.fn(() => true);
    resolveAccess({ id: "u", email: " Guru@Example.com " }, isApproved);
    expect(isApproved).toHaveBeenCalledWith("guru@example.com");
  });

  it("fails closed to anonymous when the predicate throws", () => {
    const boom = () => {
      throw new Error("env unreadable");
    };
    expect(resolveAccess({ id: "u", email: "guru@example.com" }, boom)).toEqual({
      status: "anonymous",
    });
  });

  it("uses the environment by default and re-reads it on every call", () => {
    const user = { id: "u", email: "guru@example.com" };
    vi.stubEnv("ALLOWED_EMAILS", "guru@example.com");
    expect(resolveAccess(user).status).toBe("allowed");
    vi.stubEnv("ALLOWED_EMAILS", "");
    vi.stubEnv("ADMIN_EMAIL", "");
    expect(resolveAccess(user).status).toBe("pending");
    vi.stubEnv("ADMIN_EMAIL", "guru@example.com");
    expect(resolveAccess(user).status).toBe("allowed");
  });

  it("takes the display name from the user's name, trimmed", () => {
    expect(
      resolveAccess(
        { id: "u", email: "guru@example.com", name: " Bu Guru " },
        approveAll,
      ),
    ).toMatchObject({ status: "allowed", displayName: "Bu Guru" });
    expect(
      resolveAccess(
        { id: "u", email: "guru@example.com", name: " Bu Guru " },
        approveNone,
      ),
    ).toMatchObject({ status: "pending", displayName: "Bu Guru" });
  });

  it("ignores a blank or non-string name", () => {
    expect(
      resolveAccess({ id: "u", email: "guru@example.com", name: "  " }, approveAll),
    ).toMatchObject({ status: "allowed", displayName: null });
    expect(
      resolveAccess(
        { id: "u", email: "guru@example.com", name: 5 } as unknown as SessionUser,
        approveAll,
      ),
    ).toMatchObject({ status: "allowed", displayName: null });
  });

  it("carries the session id and creation time through for both states", () => {
    const sessionCreatedAt = new Date("2026-11-22T00:00:00Z");
    const user = { id: "u", email: "g@example.com", sessionId: "s1", sessionCreatedAt };
    expect(resolveAccess(user, approveAll)).toMatchObject({
      status: "allowed",
      sessionId: "s1",
      sessionCreatedAt,
    });
    expect(resolveAccess(user, approveNone)).toMatchObject({
      status: "pending",
      sessionId: "s1",
      sessionCreatedAt,
    });
  });
});
