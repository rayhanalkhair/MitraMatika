import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(() => Promise.resolve(true)),
  auditExists: vi.fn(() => Promise.resolve(false)),
}));
vi.mock("@/lib/events", () => ({
  audit: mocks.audit,
  auditExists: mocks.auditExists,
  AUDIT_SIGN_IN: "sign_in",
  AUDIT_SIGN_OUT: "sign_out",
}));

import { auditSignIn, auditSignOut } from "./audit";

const USER = {
  status: "allowed" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  email: "teacher@example.test",
  displayName: "Bu Guru",
};

beforeEach(() => {
  mocks.audit.mockClear();
  mocks.auditExists.mockReset();
  mocks.auditExists.mockResolvedValue(false);
});

describe("auditSignIn", () => {
  it.each(["google", "email"] as const)("records sign_in for %s", async (method) => {
    await auditSignIn(method)(USER);
    expect(mocks.audit).toHaveBeenCalledWith({
      ownerId: USER.userId,
      action: "sign_in",
      metadata: { method },
    });
  });

  it("never puts the email address or display name in the record", async () => {
    await auditSignIn("google")(USER);
    const payload = JSON.stringify(mocks.audit.mock.calls);
    expect(payload).not.toContain("teacher@example.test");
    expect(payload).not.toContain("Bu Guru");
  });
});

describe("auditSignIn session dedupe", () => {
  const NOW = Date.parse("2026-11-16T10:00:00.000Z");
  const SESSION_ID = "33333333-3333-4333-8333-333333333333";
  const sessionUser = (ageMs: number) => ({
    ...USER,
    sessionId: SESSION_ID,
    sessionCreatedAt: new Date(NOW - ageMs),
  });
  const audit = () => auditSignIn("google", () => NOW);

  it("audits a fresh session once, keyed to the session", async () => {
    await audit()(sessionUser(5_000));
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith({
      ownerId: USER.userId,
      action: "sign_in",
      entityType: "session",
      entityId: SESSION_ID,
      metadata: { method: "google" },
    });
  });

  it("does not audit a session that already has a sign-in row", async () => {
    mocks.auditExists.mockResolvedValue(true);
    await audit()(sessionUser(5_000));
    expect(mocks.auditExists).toHaveBeenCalledWith({
      ownerId: USER.userId,
      action: "sign_in",
      entityType: "session",
      entityId: SESSION_ID,
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("does not audit an old session, and does not even query", async () => {
    await audit()(sessionUser(61_000));
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.auditExists).not.toHaveBeenCalled();
  });

  it("audits a session exactly at the edge of the window", async () => {
    await audit()(sessionUser(60_000));
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });
});

describe("auditSignOut", () => {
  it("records sign_out for the user", async () => {
    await auditSignOut(USER);
    expect(mocks.audit).toHaveBeenCalledWith({
      ownerId: USER.userId,
      action: "sign_out",
    });
  });
});
