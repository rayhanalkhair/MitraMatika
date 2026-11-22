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

import { requestPasswordResetAction } from "./forgot-password";

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

describe("requestPasswordResetAction", () => {
  it("requests the reset and answers the same confirmation for every address", async () => {
    const port = usePort();
    const state = await requestPasswordResetAction({}, form({ email: "A@B.test" }));
    expect(state).toEqual({ sentAt: expect.any(Number) as number });
    expect(port.calls).toEqual([
      { method: "requestPasswordReset", args: [{ email: "a@b.test" }] },
    ]);
  });

  it("reports a rate limit and a failure", async () => {
    usePort({ requestPasswordReset: failing("rate_limited") });
    expect(
      await requestPasswordResetAction({}, form({ email: "a@b.test" })),
    ).toMatchObject({ error: "rateLimited" });
    usePort({ requestPasswordReset: failing("unavailable") });
    expect(
      await requestPasswordResetAction({}, form({ email: "a@b.test" })),
    ).toMatchObject({ error: "generic" });
  });

  it("returns a field error for a malformed address", async () => {
    usePort();
    expect(await requestPasswordResetAction({}, form({ email: "" }))).toEqual({
      fieldErrors: { email: "emailInvalid" },
      values: { email: "" },
    });
  });
});
