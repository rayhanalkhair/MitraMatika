import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAuthPort } from "@/features/auth";

// The real guard, with only the framework and the auth port faked: the layout must stop a
// pending account itself. Removing the guard call, or swapping in the signed-in guard, fails here.
const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  cookies: vi.fn(),
  getAuthPort: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/features/auth/service/port-server", () => ({
  getAuthPort: mocks.getAuthPort,
}));
vi.mock("@/components/shell/AppShell", () => ({ AppShell: () => null }));

import ShellLayout from "./layout";

function signedInAs(user: { id: string; email: string } | null) {
  mocks.getAuthPort.mockResolvedValue(createFakeAuthPort({ getSessionUser: { user } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.mockResolvedValue({ get: () => undefined });
  vi.stubEnv("ADMIN_EMAIL", "boss@example.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ShellLayout with the real guard", () => {
  it("sends a pending account to /waiting-approval and renders nothing", async () => {
    signedInAs({ id: "user-2", email: "new@example.test" });
    await expect(ShellLayout({ children: "x" })).rejects.toThrow(
      "NEXT_REDIRECT:/waiting-approval",
    );
  });

  it("sends an anonymous visitor to /sign-in", async () => {
    signedInAs(null);
    await expect(ShellLayout({ children: "x" })).rejects.toThrow(
      "NEXT_REDIRECT:/sign-in",
    );
  });

  it("renders the shell for an approved account", async () => {
    signedInAs({ id: "user-1", email: "boss@example.test" });
    await expect(ShellLayout({ children: "x" })).resolves.toBeDefined();
  });
});
