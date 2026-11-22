import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn<(name: string) => { value: string } | undefined>(),
}));
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(store) }));

import {
  forgetPendingEmail,
  PENDING_EMAIL_COOKIE,
  readPendingEmail,
  rememberPendingEmail,
} from "./pending-email";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("pending email cookie", () => {
  it("is httpOnly, SameSite=Lax, sent only to /verify-email and kept for 30 minutes", async () => {
    await rememberPendingEmail("rina@example.test");
    expect(store.set).toHaveBeenCalledWith(PENDING_EMAIL_COOKIE, "rina@example.test", {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/verify-email",
      maxAge: 30 * 60,
    });
  });

  it("is Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await rememberPendingEmail("rina@example.test");
    expect(store.set.mock.calls[0][2]).toMatchObject({ secure: true });
  });

  it("is forgotten by expiring it on the same path", async () => {
    await forgetPendingEmail();
    expect(store.set).toHaveBeenCalledWith(
      PENDING_EMAIL_COOKIE,
      "",
      expect.objectContaining({ path: "/verify-email", maxAge: 0, httpOnly: true }),
    );
  });

  it("reads back a remembered address", async () => {
    store.get.mockReturnValue({ value: "rina@example.test" });
    expect(await readPendingEmail()).toBe("rina@example.test");
    expect(store.get).toHaveBeenCalledWith(PENDING_EMAIL_COOKIE);
  });

  it.each([undefined, { value: "" }, { value: "not-an-email" }, { value: "<b>@x" }])(
    "reads nothing from %o",
    async (cookie) => {
      store.get.mockReturnValue(cookie);
      expect(await readPendingEmail()).toBeUndefined();
    },
  );
});
