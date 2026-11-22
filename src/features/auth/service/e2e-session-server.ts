import { cookies } from "next/headers";
import { E2E_COOKIE, isFakeAuthEnabled } from "./e2e-session";

// Kept apart from e2e-session.ts so the proxy bundle never imports next/headers.
export async function clearFakeSession(): Promise<void> {
  if (!isFakeAuthEnabled()) return;
  try {
    (await cookies()).delete(E2E_COOKIE);
  } catch {
    // Fake mode only: the sign-out and denied redirects must always happen.
  }
}
