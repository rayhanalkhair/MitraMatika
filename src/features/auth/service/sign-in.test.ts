import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureProfile: vi.fn(() => Promise.resolve({ ok: true as const })),
}));
vi.mock("./profile", () => ({ ensureProfile: mocks.ensureProfile }));

import { createFakeAuthPort } from "./fake-port";
import { completeSignIn } from "./sign-in";

const session = (email: string, name?: string) => ({
  getSessionUser: { user: { id: "user-1", email, ...(name ? { name } : {}) } },
});

const profileFails = () =>
  mocks.ensureProfile.mockResolvedValueOnce({
    ok: false,
    error: "generic",
  } as never);

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("completeSignIn", () => {
  it("creates the profile and succeeds for an approved signed-in account", async () => {
    vi.stubEnv("ADMIN_EMAIL", "teacher@example.com");
    const port = createFakeAuthPort(session("Teacher@Example.com", "Bu Guru"));
    expect(await completeSignIn(port)).toEqual({ ok: true });
    expect(port.calls.map((call) => call.method)).toEqual(["getSessionUser"]);
    expect(mocks.ensureProfile).toHaveBeenCalledWith({
      status: "allowed",
      userId: "user-1",
      email: "teacher@example.com",
      displayName: "Bu Guru",
    });
  });

  it("creates the profile and succeeds for a pending account too", async () => {
    vi.stubEnv("ADMIN_EMAIL", "someone-else@example.com");
    const port = createFakeAuthPort(session("new@example.com", "Bu Baru"));
    expect(await completeSignIn(port)).toEqual({ ok: true });
    expect(port.calls.map((call) => call.method)).toEqual(["getSessionUser"]);
    expect(mocks.ensureProfile).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending", userId: "user-1" }),
    );
  });

  it("signs out and reports generic when there is no session after sign-in", async () => {
    const port = createFakeAuthPort();
    expect(await completeSignIn(port)).toEqual({
      ok: false,
      error: "generic",
    });
    expect(port.calls.map((call) => call.method)).toEqual(["getSessionUser", "signOut"]);
  });

  it("signs out and reports generic when reading the session throws", async () => {
    const port = createFakeAuthPort({ getSessionUser: { throws: new Error("down") } });
    expect(await completeSignIn(port)).toEqual({
      ok: false,
      error: "generic",
    });
    expect(port.calls.map((call) => call.method)).toEqual(["getSessionUser", "signOut"]);
  });

  it("fails closed when the profile cannot be created: signs out and reports generic", async () => {
    profileFails();
    const port = createFakeAuthPort(session("teacher@example.com"));
    expect(await completeSignIn(port)).toEqual({
      ok: false,
      error: "generic",
    });
    expect(port.calls.map((call) => call.method)).toEqual(["getSessionUser", "signOut"]);
  });
});

describe("completeSignIn onSignedIn callback", () => {
  const allowedPort = () => {
    vi.stubEnv("ADMIN_EMAIL", "teacher@example.com");
    return createFakeAuthPort(session("teacher@example.com"));
  };

  it("is called once with the allowed user after the profile exists", async () => {
    let profileCallsAtCallback = -1;
    const onSignedIn = vi.fn(() => {
      profileCallsAtCallback = mocks.ensureProfile.mock.calls.length;
    });
    expect(await completeSignIn(allowedPort(), onSignedIn)).toEqual({
      ok: true,
    });
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(onSignedIn).toHaveBeenCalledWith(
      expect.objectContaining({ status: "allowed", userId: "user-1" }),
    );
    // the profile upsert had already happened when the callback ran
    expect(profileCallsAtCallback).toBe(1);
  });

  it("is not called when there is no session", async () => {
    const onSignedIn = vi.fn();
    await completeSignIn(createFakeAuthPort(), onSignedIn);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("is not called when the profile cannot be created", async () => {
    profileFails();
    const onSignedIn = vi.fn();
    await completeSignIn(allowedPort(), onSignedIn);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("does not fail the sign-in when the callback throws or rejects", async () => {
    const throwing = vi.fn(() => {
      throw new Error("audit down");
    });
    expect(await completeSignIn(allowedPort(), throwing)).toEqual({
      ok: true,
    });
    const rejecting = vi.fn(() => {
      return Promise.reject(new Error("audit down"));
    });
    expect(await completeSignIn(allowedPort(), rejecting)).toEqual({
      ok: true,
    });
  });
});
