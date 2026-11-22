import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createResendSender: vi.fn(() => () => Promise.resolve({ ok: true as const })),
}));
vi.mock("./resend", () => ({ createResendSender: mocks.createResendSender }));

import { getEmailSender } from "./index";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("getEmailSender", () => {
  it("returns a sender that reports email_not_configured when nothing is set", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");
    const send = getEmailSender();
    await expect(send({ to: "a@b.co", subject: "s", text: "t" })).resolves.toEqual({
      ok: false,
      error: "email_not_configured",
    });
    expect(mocks.createResendSender).not.toHaveBeenCalled();
  });

  it.each([
    ["only the key", { RESEND_API_KEY: "re_test_key", EMAIL_FROM: "" }],
    [
      "only the sender address",
      { RESEND_API_KEY: "", EMAIL_FROM: "MitraMatika <a@b.co>" },
    ],
  ])("is not configured with %s", async (_label, vars) => {
    for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
    await expect(
      getEmailSender()({ to: "a@b.co", subject: "s", text: "t" }),
    ).resolves.toEqual({ ok: false, error: "email_not_configured" });
  });

  it("uses Resend when the key and the sender address are both set", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("EMAIL_FROM", "MitraMatika <noreply@example.test>");
    getEmailSender();
    expect(mocks.createResendSender).toHaveBeenCalledWith({
      apiKey: "re_test_key",
      from: "MitraMatika <noreply@example.test>",
    });
  });
});
