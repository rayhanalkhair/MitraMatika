import type { SessionUser } from "./auth-port";

export const E2E_COOKIE = "e2e-user";

/**
 * Test-only seam: Playwright's dev server sets E2E_FAKE_AUTH=1 so the signed-in user can come
 * from a cookie instead of Better Auth. It works only when NODE_ENV is "development" or "test"
 * (an allow-list: unset or any other value is off), so it is hard-disabled in production (Vercel
 * builds and `next start` always run with NODE_ENV=production) no matter what the flag says.
 */
export function isFakeAuthEnabled(): boolean {
  return (
    process.env.E2E_FAKE_AUTH === "1" &&
    (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test")
  );
}

/**
 * The one identity the seam can sign in: a fixed test user (the CI seed inserts exactly this
 * "user"/profiles row). The cookie names it by email; any other value is anonymous, so the seam
 * can never be used to act as an arbitrary account.
 */
export const E2E_FAKE_USER = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "teacher@example.test",
} as const;

export function fakeSessionUser(cookieValue: string | undefined): SessionUser | null {
  if (!isFakeAuthEnabled() || cookieValue !== E2E_FAKE_USER.email) return null;
  return { id: E2E_FAKE_USER.id, email: E2E_FAKE_USER.email };
}
