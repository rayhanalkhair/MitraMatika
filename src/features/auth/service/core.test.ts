import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureProfile: vi.fn(() => Promise.resolve({ ok: true as const })),
}));
vi.mock("./profile", () => ({ ensureProfile: mocks.ensureProfile }));

import type { AuthPortGetter } from "./auth-port";
import { EMAIL_SIGN_IN_CALLBACK, resolvePostSignInRedirect, signOutUser } from "./core";
import { createFakeAuthPort, type FakeAuthPort } from "./fake-port";

const getterFor =
  (port: FakeAuthPort): AuthPortGetter =>
  () =>
    Promise.resolve(port);

const signedIn = (email: string) => ({
  getSessionUser: { user: { id: "user-1", email } },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("signOutUser", () => {
  it("signs out and succeeds", async () => {
    const port = createFakeAuthPort();
    expect(await signOutUser(getterFor(port))).toEqual({ ok: true });
    expect(port.calls).toEqual([{ method: "signOut", args: [] }]);
  });

  it("maps a port error to generic", async () => {
    const port = createFakeAuthPort({ signOut: { error: { code: "unavailable" } } });
    expect(await signOutUser(getterFor(port))).toEqual({
      ok: false,
      error: "generic",
    });
  });

  it("maps a port that cannot be created to generic", async () => {
    const getPort: AuthPortGetter = () => Promise.reject(new Error("no env"));
    expect(await signOutUser(getPort)).toEqual({ ok: false, error: "generic" });
  });
});

describe("resolvePostSignInRedirect", () => {
  const params = (query = "") => new URLSearchParams(query);

  it("completes sign-in for any signed-in account and goes home", async () => {
    const onSignedIn = vi.fn();
    const port = createFakeAuthPort(signedIn("anyone@example.com"));
    expect(await resolvePostSignInRedirect(getterFor(port), params(), onSignedIn)).toBe(
      "/home",
    );
    expect(mocks.ensureProfile).toHaveBeenCalledTimes(1);
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it.each(["access_denied", "EMAIL_NOT_VERIFIED", "EMAIL_NOT_ALLOWED"])(
    "maps a Better Auth error (%s) to oauthDenied without a port",
    async (error) => {
      const getPort = vi.fn<AuthPortGetter>();
      expect(await resolvePostSignInRedirect(getPort, params(`error=${error}`))).toBe(
        "/sign-in?error=oauthDenied",
      );
      expect(getPort).not.toHaveBeenCalled();
    },
  );

  it.each(["TOKEN_EXPIRED", "INVALID_TOKEN", "USER_NOT_FOUND"])(
    "sends a failed verification link (%s) to the verify-email page without a port",
    async (error) => {
      const getPort = vi.fn<AuthPortGetter>();
      expect(
        await resolvePostSignInRedirect(getPort, params(`method=email&error=${error}`)),
      ).toBe("/verify-email?error=invalid");
      expect(getPort).not.toHaveBeenCalled();
    },
  );

  it("completes a verification-link sign-in like any other and goes home", async () => {
    const port = createFakeAuthPort(signedIn("guru@example.test"));
    expect(await resolvePostSignInRedirect(getterFor(port), params("method=email"))).toBe(
      "/home",
    );
  });

  it("a verification link opened again (no session, no error) shows the used-link notice", async () => {
    const port = createFakeAuthPort();
    expect(await resolvePostSignInRedirect(getterFor(port), params("method=email"))).toBe(
      "/sign-in?notice=linkUsed",
    );
    expect(mocks.ensureProfile).not.toHaveBeenCalled();
  });

  it("the verification links come back to the callback marked as email", () => {
    expect(EMAIL_SIGN_IN_CALLBACK).toBe("/auth/callback?method=email");
  });

  it("signs out and reports generic when there is no session", async () => {
    const port = createFakeAuthPort();
    expect(await resolvePostSignInRedirect(getterFor(port), params())).toBe(
      "/sign-in?error=generic",
    );
    expect(port.calls.map((call) => call.method)).toEqual(["getSessionUser", "signOut"]);
  });

  it("reports generic when the port cannot be created", async () => {
    const getPort: AuthPortGetter = () => Promise.reject(new Error("no env"));
    expect(await resolvePostSignInRedirect(getPort, params())).toBe(
      "/sign-in?error=generic",
    );
  });
});
