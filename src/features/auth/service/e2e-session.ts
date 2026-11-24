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
 * The main identity the seam can sign in: a fixed test user (the CI seed inserts exactly this
 * "user"/profiles row). The cookie names it by email; any other value (but the pending identity's, below) is
 * anonymous, so the seam can never be used to act as an arbitrary account.
 */
export const E2E_FAKE_USER = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "teacher@example.test",
} as const;

/**
 * A second fixed identity for the pending-account specs: the seam never marks anyone approved,
 * so this one is pending whenever CI's approval list does not name it. Its session carries a
 * creation time (the account-deletion check needs a recent sign-in for an account without a
 * password).
 */
export const E2E_FAKE_PENDING_USER = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "pending@example.test",
} as const;

/**
 * A third fixed identity for the admin specs: a verified account that the e2e approval list does
 * not name. It is approved only because the environment sets ADMIN_EMAIL to its address (the seam
 * carries no approval of its own), so the spec proves the ADMIN_EMAIL path of the access gate.
 */
export const E2E_FAKE_ADMIN_USER = {
  id: "00000000-0000-4000-8000-000000000003",
  email: "admin@example.test",
} as const;

export function fakeSessionUser(cookieValue: string | undefined): SessionUser | null {
  if (!isFakeAuthEnabled()) return null;
  if (cookieValue === E2E_FAKE_USER.email) {
    return { id: E2E_FAKE_USER.id, email: E2E_FAKE_USER.email };
  }
  if (cookieValue === E2E_FAKE_ADMIN_USER.email) {
    return { id: E2E_FAKE_ADMIN_USER.id, email: E2E_FAKE_ADMIN_USER.email };
  }
  if (cookieValue === E2E_FAKE_PENDING_USER.email) {
    return {
      id: E2E_FAKE_PENDING_USER.id,
      email: E2E_FAKE_PENDING_USER.email,
      sessionCreatedAt: new Date(),
    };
  }
  return null;
}
