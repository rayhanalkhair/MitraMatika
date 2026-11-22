import "server-only";
import { cookies, headers } from "next/headers";
import { requireBetterAuthUrl } from "@/lib/env";
import { createAuthPort, withCurrentCookies, type AuthPort } from "./auth-port";
import { getAuth } from "./auth-server";

// The AuthPortGetter the app uses: the lazily built Better Auth instance, bound to the current
// request's headers and cookie store. Rejects while Better Auth is not configured; every caller
// maps that to a generic error or to "anonymous".
export function getAuthPort(): Promise<AuthPort> {
  return Promise.resolve().then(() =>
    createAuthPort(getAuth(), {
      baseURL: requireBetterAuthUrl(),
      requestHeaders: async () =>
        withCurrentCookies(await headers(), (await cookies()).getAll()),
      setCookie: async (name, value, options) => {
        (await cookies()).set(name, value, options);
      },
    }),
  );
}
