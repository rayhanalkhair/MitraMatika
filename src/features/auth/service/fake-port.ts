import type { AuthPort, AuthPortError, SessionUser } from "./auth-port";

type Method =
  | "signOut"
  | "getSessionUser"
  | "signInEmail"
  | "signUpEmail"
  | "sendVerificationEmail"
  | "requestPasswordReset"
  | "resetPassword"
  | "changePassword"
  | "verifyPassword";

export type FakeResponse =
  { error?: AuthPortError | null; user?: SessionUser | null } | { throws: Error };

export type FakeAuthPort = AuthPort & {
  calls: { method: Method; args: unknown[] }[];
};

// In-memory AuthPort for tests: records every call and answers from `responses`
// (default: success, no session).
export function createFakeAuthPort(
  responses: Partial<Record<Method, FakeResponse>> = {},
): FakeAuthPort {
  const calls: FakeAuthPort["calls"] = [];

  const next = (method: Method, args: unknown[]) => {
    calls.push({ method, args });
    const response = responses[method] ?? {};
    if ("throws" in response) throw response.throws;
    return response;
  };

  const answer = (method: Method, args: unknown[]) =>
    Promise.resolve({ error: next(method, args).error ?? null });

  return {
    calls,
    signOut: () => answer("signOut", []),
    getSessionUser: () => Promise.resolve(next("getSessionUser", []).user ?? null),
    signInEmail: (input) => answer("signInEmail", [input]),
    signUpEmail: (input) => answer("signUpEmail", [input]),
    sendVerificationEmail: (input) => answer("sendVerificationEmail", [input]),
    requestPasswordReset: (input) => answer("requestPasswordReset", [input]),
    resetPassword: (input) => answer("resetPassword", [input]),
    changePassword: (input) => answer("changePassword", [input]),
    verifyPassword: (input) => answer("verifyPassword", [input]),
  };
}
