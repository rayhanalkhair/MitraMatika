export const TEACHER_EMAIL = "teacher@example.test";
export const E2E_COOKIE = "e2e-user";

export const ANONYMOUS_STATE = { cookies: [], origins: [] };

// A Playwright storageState signed in (via the dev-only fake-session seam) as `email`.
export function signedInState(email: string = TEACHER_EMAIL) {
  return {
    cookies: [
      {
        name: E2E_COOKIE,
        value: email,
        domain: "localhost",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };
}

// Dummy bearer secret (32+ characters) for POST /api/jobs/run on the throwaway CI database; the
// config hands it to the dev server as CRON_SECRET and the specs use it to run due jobs (retry
// backoff) as a manual run.
export const E2E_RUNNER_SECRET = "e2e-ci-runner-dummy-0000000000000000";
