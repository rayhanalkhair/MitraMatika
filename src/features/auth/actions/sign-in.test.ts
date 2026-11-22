import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPortError } from "../service/auth-port";
import { createFakeAuthPort, type FakeAuthPort } from "../service/fake-port";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  getAuthPort: vi.fn(),
  rememberPendingEmail: vi.fn(() => Promise.resolve()),
  forgetPendingEmail: vi.fn(() => Promise.resolve()),
  completeSignIn: vi.fn(() => Promise.resolve({ ok: true as const, data: undefined })),
  auditSignIn: vi.fn((method: string) => `audit:${method}`),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("../service/port-server", () => ({ getAuthPort: mocks.getAuthPort }));
vi.mock("../service/pending-email", () => ({
  rememberPendingEmail: mocks.rememberPendingEmail,
  forgetPendingEmail: mocks.forgetPendingEmail,
}));
vi.mock("../service/sign-in", () => ({ completeSignIn: mocks.completeSignIn }));
vi.mock("../service/audit", () => ({ auditSignIn: mocks.auditSignIn }));

import { signInAction } from "./sign-in";

const CALLBACK = "/auth/callback?method=email";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

function usePort(responses: Parameters<typeof createFakeAuthPort>[0] = {}): FakeAuthPort {
  const port = createFakeAuthPort(responses);
  mocks.getAuthPort.mockResolvedValue(port);
  return port;
}

const failing = (code: AuthPortError["code"]) => ({ error: { code } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("signInAction", () => {
  const valid = form({ email: " Guru@Example.test ", password: "rahasia123" });

  it("signs in through the port, completes the sign-in and goes home", async () => {
    const port = usePort();
    await expect(signInAction({}, valid)).rejects.toThrow("NEXT_REDIRECT:/home");
    expect(port.calls).toEqual([
      {
        method: "signInEmail",
        args: [
          { email: "guru@example.test", password: "rahasia123", callbackURL: CALLBACK },
        ],
      },
    ]);
    expect(mocks.completeSignIn).toHaveBeenCalledWith(port, "audit:email");
    expect(mocks.forgetPendingEmail).toHaveBeenCalledTimes(1);
  });

  it("returns field errors without calling the port", async () => {
    const port = usePort();
    expect(await signInAction({}, form({ email: "x", password: "" }))).toEqual({
      fieldErrors: { email: "emailInvalid", password: "passwordRequired" },
      values: { email: "x" },
    });
    expect(port.calls).toEqual([]);
  });

  it.each([
    ["invalid_credentials", "invalidCredentials"],
    ["rate_limited", "rateLimited"],
    ["unavailable", "generic"],
  ] as const)("maps %s to %s and keeps the address", async (code, error) => {
    usePort({ signInEmail: failing(code) });
    expect(await signInAction({}, valid)).toEqual({
      error,
      values: { email: " Guru@Example.test " },
    });
    expect(mocks.completeSignIn).not.toHaveBeenCalled();
  });

  it("an unverified address answers emailNotVerified and remembers it for the resend page", async () => {
    usePort({ signInEmail: failing("email_not_verified") });
    expect(await signInAction({}, valid)).toMatchObject({ error: "emailNotVerified" });
    expect(mocks.rememberPendingEmail).toHaveBeenCalledWith("guru@example.test");
  });

  it("answers generic when the sign-in cannot be completed", async () => {
    usePort();
    mocks.completeSignIn.mockResolvedValueOnce({ ok: false, error: "generic" } as never);
    expect(await signInAction({}, valid)).toMatchObject({ error: "generic" });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("answers generic when Better Auth is not configured", async () => {
    mocks.getAuthPort.mockRejectedValue(new Error("no env"));
    expect(await signInAction({}, valid)).toMatchObject({ error: "generic" });
  });
});
