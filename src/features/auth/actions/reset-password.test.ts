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

import { resetPasswordAction } from "./reset-password";

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

describe("resetPasswordAction", () => {
  const valid = { token: "tok", password: "baru12345", confirmPassword: "baru12345" };

  it("sets the new password and sends the user to sign in with a notice", async () => {
    const port = usePort();
    await expect(resetPasswordAction({}, form(valid))).rejects.toThrow(
      "NEXT_REDIRECT:/sign-in?notice=passwordReset",
    );
    expect(port.calls).toEqual([
      { method: "resetPassword", args: [{ token: "tok", newPassword: "baru12345" }] },
    ]);
  });

  it("an invalid or used token shows the expired state", async () => {
    usePort({ resetPassword: failing("invalid_token") });
    expect(await resetPasswordAction({}, form(valid))).toEqual({ expired: true });
  });

  it("a missing token shows the expired state without calling the port", async () => {
    const port = usePort();
    expect(await resetPasswordAction({}, form({ ...valid, token: "" }))).toEqual({
      expired: true,
    });
    expect(port.calls).toEqual([]);
  });

  it("returns field errors for a weak or mismatched password", async () => {
    const port = usePort();
    expect(
      await resetPasswordAction(
        {},
        form({ token: "tok", password: "abcdefgh", confirmPassword: "x" }),
      ),
    ).toEqual({
      fieldErrors: {
        password: "passwordNeedsLetterAndDigit",
        confirmPassword: "passwordMismatch",
      },
    });
    expect(port.calls).toEqual([]);
  });

  it("maps a rate limit", async () => {
    usePort({ resetPassword: failing("rate_limited") });
    expect(await resetPasswordAction({}, form(valid))).toEqual({ error: "rateLimited" });
  });
});
