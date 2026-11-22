import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAuthPort } from "@/features/auth";

const mocks = vi.hoisted(() => ({
  getAuthPort: vi.fn(),
  ensureProfile: vi.fn(() => Promise.resolve({ ok: true as const })),
  audit: vi.fn<(entry?: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
  auditExists: vi.fn<(entry?: unknown) => Promise<boolean>>(() => Promise.resolve(false)),
}));

vi.mock("@/features/auth/service/port-server", () => ({
  getAuthPort: mocks.getAuthPort,
}));
vi.mock("@/features/auth/service/profile", () => ({
  ensureProfile: mocks.ensureProfile,
}));
vi.mock("@/lib/events", () => ({
  audit: mocks.audit,
  auditExists: mocks.auditExists,
  AUDIT_SIGN_IN: "auth.sign_in",
  AUDIT_SIGN_OUT: "auth.sign_out",
}));

import { GET } from "./route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

// A stateful stand-in for the audit table, so repeated hits behave like the real thing.
function auditStore() {
  const rows = new Set<string>();
  mocks.audit.mockImplementation((entry?: unknown) => {
    rows.add((entry as { entityId: string }).entityId);
    return Promise.resolve(true);
  });
  mocks.auditExists.mockImplementation((entry?: unknown) =>
    Promise.resolve(rows.has((entry as { entityId: string }).entityId)),
  );
  return rows;
}

function signedInSession(ageMs: number) {
  const port = createFakeAuthPort({
    getSessionUser: {
      user: {
        id: USER_ID,
        email: "teacher@example.test",
        sessionId: SESSION_ID,
        sessionCreatedAt: new Date(Date.now() - ageMs),
      },
    },
  });
  mocks.getAuthPort.mockResolvedValue(port);
}

const callback = (query = "") =>
  GET(new Request(`http://localhost:3000/auth/callback${query}`));

function signedInAs(email: string | null) {
  const port = createFakeAuthPort({
    getSessionUser: { user: email ? { id: "user-1", email } : null },
  });
  mocks.getAuthPort.mockResolvedValue(port);
  return port;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /auth/callback (after Better Auth finished the Google callback)", () => {
  it("creates the profile, audits the sign-in and redirects a signed-in user to /home", async () => {
    signedInAs("teacher@example.test");
    const response = await callback();
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/home");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.ensureProfile).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
    );
    expect(mocks.audit).toHaveBeenCalledWith({
      ownerId: "user-1",
      action: "auth.sign_in",
      metadata: { method: "google" },
    });
  });

  it("signs in any Google account: no allowlist, no noAccess", async () => {
    signedInAs("stranger@example.test");
    const response = await callback();
    expect(response.headers.get("location")).toBe("http://localhost:3000/home");
    expect(mocks.ensureProfile).toHaveBeenCalledWith(
      expect.objectContaining({ email: "stranger@example.test" }),
    );
  });

  it.each([
    "access_denied",
    "state_mismatch",
    "unable_to_create_user",
    "EMAIL_NOT_VERIFIED",
  ])("redirects with oauthDenied when Better Auth reports %s", async (error) => {
    const response = await callback(`?error=${error}`);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/sign-in?error=oauthDenied",
    );
    expect(mocks.getAuthPort).not.toHaveBeenCalled();
  });

  it("audits a verification-link sign-in as email", async () => {
    signedInAs("teacher@example.test");
    const response = await callback("?method=email");
    expect(response.headers.get("location")).toBe("http://localhost:3000/home");
    expect(mocks.audit).toHaveBeenCalledWith({
      ownerId: "user-1",
      action: "auth.sign_in",
      metadata: { method: "email" },
    });
  });

  it("forgets the pending address once a verification link has signed the user in", async () => {
    signedInAs("teacher@example.test");
    const response = await callback("?method=email");
    expect(response.headers.get("set-cookie")).toMatch(
      /^mm-pending-email=; Path=\/verify-email; .*Max-Age=0/,
    );
  });

  it("leaves the pending address alone for Google and for a used link", async () => {
    signedInAs("teacher@example.test");
    expect((await callback()).headers.get("set-cookie")).toBeNull();
    signedInAs(null);
    const used = await callback("?method=email");
    expect(used.headers.get("location")).toBe(
      "http://localhost:3000/sign-in?notice=linkUsed",
    );
    expect(used.headers.get("set-cookie")).toBeNull();
  });

  it("sends a failed verification link to /verify-email", async () => {
    const response = await callback("?method=email&error=TOKEN_EXPIRED");
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/verify-email?error=invalid",
    );
    expect(mocks.getAuthPort).not.toHaveBeenCalled();
  });

  it("redirects with generic when there is no session", async () => {
    signedInAs(null);
    const response = await callback();
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/sign-in?error=generic",
    );
  });

  it("redirects with generic when Better Auth is not configured", async () => {
    mocks.getAuthPort.mockRejectedValue(new Error("BETTER_AUTH_SECRET tidak ditemukan"));
    const response = await callback();
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/sign-in?error=generic",
    );
  });
});

describe("GET /auth/callback sign-in audit dedupe", () => {
  beforeEach(() => {
    mocks.audit.mockReset();
    mocks.auditExists.mockReset();
  });

  it("audits a fresh session once, however often the URL is hit", async () => {
    const rows = auditStore();
    signedInSession(2_000);
    for (let i = 0; i < 3; i += 1) {
      const response = await callback();
      expect(response.headers.get("location")).toBe("http://localhost:3000/home");
    }
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
  });

  it("audits nothing for an old session but still redirects to /home", async () => {
    auditStore();
    signedInSession(10 * 60_000);
    const response = await callback();
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/home");
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
