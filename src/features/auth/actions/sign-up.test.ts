import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPortError } from "../service/auth-port";
import { createFakeAuthPort, type FakeAuthPort } from "../service/fake-port";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  getAuthPort: vi.fn(),
  rememberPendingEmail: vi.fn(() => Promise.resolve()),
  completeSignIn: vi.fn(() => Promise.resolve({ ok: true as const, data: undefined })),
  auditSignIn: vi.fn((method: string) => `audit:${method}`),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("../service/port-server", () => ({ getAuthPort: mocks.getAuthPort }));
vi.mock("../service/pending-email", () => ({
  rememberPendingEmail: mocks.rememberPendingEmail,
}));
vi.mock("../service/sign-in", () => ({ completeSignIn: mocks.completeSignIn }));
vi.mock("../service/audit", () => ({ auditSignIn: mocks.auditSignIn }));

import { signUpAction } from "./sign-up";

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

describe("signUpAction", () => {
  const fields = {
    name: "Bu Rina",
    email: "Rina@Example.test",
    password: "rahasia123",
    confirmPassword: "rahasia123",
    schoolName: "SMP 1",
    acceptPrivacy: "on",
  };

  it("signs up through the port, remembers the address and shows the verify-email notice", async () => {
    const port = usePort();
    await expect(signUpAction({}, form(fields))).rejects.toThrow(
      "NEXT_REDIRECT:/verify-email",
    );
    expect(port.calls).toEqual([
      {
        method: "signUpEmail",
        args: [
          {
            name: "Bu Rina",
            email: "rina@example.test",
            password: "rahasia123",
            schoolName: "SMP 1",
            callbackURL: CALLBACK,
          },
        ],
      },
    ]);
    expect(mocks.rememberPendingEmail).toHaveBeenCalledWith("rina@example.test");
  });

  it("returns every field error and the typed values (never the passwords)", async () => {
    const port = usePort();
    const state = await signUpAction(
      {},
      form({
        name: "R",
        email: "x",
        password: "a",
        confirmPassword: "b",
        schoolName: "S",
      }),
    );
    expect(state).toEqual({
      fieldErrors: {
        name: "nameLength",
        email: "emailInvalid",
        password: "passwordTooShort",
        confirmPassword: "passwordMismatch",
        acceptPrivacy: "privacyRequired",
      },
      values: { name: "R", email: "x", schoolName: "S", acceptPrivacy: "" },
    });
    expect(port.calls).toEqual([]);
  });

  it.each([
    ["rate_limited", "rateLimited"],
    ["invalid_input", "generic"],
    ["unavailable", "generic"],
  ] as const)("maps %s to %s", async (code, error) => {
    usePort({ signUpEmail: failing(code) });
    expect(await signUpAction({}, form(fields))).toMatchObject({ error });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
