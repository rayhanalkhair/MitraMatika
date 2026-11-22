import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import { CLIENT_IP_HEADER, resolveClientIp } from "./client-ip";

// `name` is optional on top of the brief's { id, email }: Google gives a display name the profile
// row starts from.
export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  /** The Better Auth session this user was read from, when the port knows it. */
  sessionId?: string | null;
  sessionCreatedAt?: Date | null;
}
export interface AuthPortError {
  code:
    | "rate_limited"
    | "unavailable"
    | "invalid_credentials"
    | "wrong_password"
    | "email_not_verified"
    | "invalid_token"
    | "invalid_input";
}
export type AuthPortResult = Promise<{ error: AuthPortError | null }>;

export interface EmailSignIn {
  email: string;
  password: string;
  /** Where the verification link resent on an unverified sign-in leads (a relative path). */
  callbackURL: string;
}
export interface EmailSignUp {
  name: string;
  email: string;
  password: string;
  schoolName?: string;
  /** Where the verification link leads (a relative path). */
  callbackURL: string;
}

export interface AuthPort {
  signOut(): AuthPortResult;
  getSessionUser(): Promise<SessionUser | null>;
  signInEmail(input: EmailSignIn): AuthPortResult;
  signUpEmail(input: EmailSignUp): AuthPortResult;
  sendVerificationEmail(input: { email: string; callbackURL: string }): AuthPortResult;
  /** The address only: the reset link always leads to the app's reset page (auth-server.ts). */
  requestPasswordReset(input: { email: string }): AuthPortResult;
  resetPassword(input: { token: string; newPassword: string }): AuthPortResult;
  /**
   * The signed-in user's password (Settings). Needs the current one; ends every other session and
   * replaces this one (its new cookie is set).
   */
  changePassword(input: { currentPassword: string; newPassword: string }): AuthPortResult;
  /** Checks the signed-in user's current password (before an account deletion). */
  verifyPassword(input: { password: string }): AuthPortResult;
}
export type AuthPortGetter = () => Promise<AuthPort>;

// The slice of a Better Auth instance the port needs.
export interface AuthHandle {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(args: { headers: Headers }): Promise<{
      user: { id: string; email: string; name?: string | null };
      session?: { id?: string; createdAt?: Date | string | number } | null;
    } | null>;
  };
}

export type CookieOptions = ReturnType<typeof toCookieOptions>;

// What the port needs from the incoming request: its headers, and a way to set response cookies.
export interface PortIO {
  baseURL: string;
  requestHeaders(): Promise<Headers>;
  setCookie(name: string, value: string, options: CookieOptions): void | Promise<void>;
}

// Next's request headers keep the Cookie header the request arrived with, while the cookie store
// already holds what this request set (a session that was just created, or one just ended).
// Better Auth reads the session from the header, so rebuild it from the store.
export function withCurrentCookies(
  incoming: Headers,
  current: readonly { name: string; value: string }[],
): Headers {
  const merged = new Headers(incoming);
  const pairs = current
    .filter((cookie) => cookie.value !== "")
    .map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`);
  if (pairs.length > 0) merged.set("cookie", pairs.join("; "));
  else merged.delete("cookie");
  return merged;
}

const AUTH_PATH = "/api/auth";
// Other headers Better Auth uses for session metadata and its own checks. The client address is
// not copied from the incoming request: it is resolved by resolveClientIp and passed in the one
// dedicated header (CLIENT_IP_HEADER), or not at all.
const FORWARDED = ["user-agent"];

// Better Auth's error codes (and the policy codes of auth-server.ts) the app tells apart. None of
// them depends on whether an address has an account: EMAIL_NOT_VERIFIED comes only after the
// right password. Anything else is "unavailable".
const ERROR_CODES: Record<string, AuthPortError["code"]> = {
  TOO_MANY_ATTEMPTS: "rate_limited",
  INVALID_EMAIL_OR_PASSWORD: "invalid_credentials",
  // Only for the signed-in user's own account (change-password).
  INVALID_PASSWORD: "wrong_password",
  EMAIL_NOT_VERIFIED: "email_not_verified",
  INVALID_TOKEN: "invalid_token",
  TOKEN_EXPIRED: "invalid_token",
  USER_NOT_FOUND: "invalid_token",
  PASSWORD_TOO_SHORT: "invalid_input",
  PASSWORD_TOO_LONG: "invalid_input",
  PASSWORD_NEEDS_LETTER_AND_DIGIT: "invalid_input",
  INVALID_SIGN_UP: "invalid_input",
  INVALID_EMAIL: "invalid_input",
  VALIDATION_ERROR: "invalid_input",
};

async function toError(response: Response): Promise<AuthPortError> {
  if (response.status === 429) return { code: "rate_limited" };
  let code: unknown;
  try {
    code = ((await response.json()) as { code?: unknown }).code;
  } catch {
    code = undefined;
  }
  return { code: (typeof code === "string" && ERROR_CODES[code]) || "unavailable" };
}

/**
 * The Better Auth implementation of `AuthPort`. Calls go through `auth.handler` with a real
 * Request rather than `auth.api`: only the handler applies Better Auth's rate limiter, keyed by
 * the client IP forwarded from the incoming request.
 */
export function createAuthPort(auth: AuthHandle, io: PortIO): AuthPort {
  const origin = new URL(io.baseURL).origin;

  async function call(path: string, body: unknown, withCookie = false): AuthPortResult {
    const incoming = await io.requestHeaders();
    const headers = new Headers({ "content-type": "application/json", origin });
    for (const name of withCookie ? [...FORWARDED, "cookie"] : FORWARDED) {
      const value = incoming.get(name);
      if (value) headers.set(name, value);
    }
    const clientIp = resolveClientIp(incoming);
    if (clientIp) headers.set(CLIENT_IP_HEADER, clientIp);
    const response = await auth.handler(
      new Request(`${origin}${AUTH_PATH}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok) return { error: await toError(response) };

    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      for (const [name, attributes] of parseSetCookieHeader(setCookie)) {
        await io.setCookie(name, attributes.value, toCookieOptions(attributes));
      }
    }
    return { error: null };
  }

  return {
    signOut() {
      return call("/sign-out", {}, true);
    },
    signInEmail({ email, password, callbackURL }) {
      return call("/sign-in/email", { email, password, callbackURL });
    },
    signUpEmail({ name, email, password, schoolName, callbackURL }) {
      // The action has already checked the privacy consent; Better Auth's hook requires it too.
      return call("/sign-up/email", {
        name,
        email,
        password,
        schoolName,
        callbackURL,
        acceptPrivacy: true,
      });
    },
    sendVerificationEmail({ email, callbackURL }) {
      return call("/send-verification-email", { email, callbackURL });
    },
    requestPasswordReset({ email }) {
      return call("/request-password-reset", { email });
    },
    resetPassword({ token, newPassword }) {
      return call("/reset-password", { token, newPassword });
    },
    changePassword({ currentPassword, newPassword }) {
      return call(
        "/change-password",
        { currentPassword, newPassword, revokeOtherSessions: true },
        true,
      );
    },
    verifyPassword({ password }) {
      return call("/verify-password", { password }, true);
    },
    async getSessionUser() {
      const session = await auth.api.getSession({ headers: await io.requestHeaders() });
      if (!session) return null;
      const { id, email, name } = session.user;
      const created =
        session.session?.createdAt === undefined
          ? null
          : new Date(session.session.createdAt);
      return {
        id,
        email,
        name: name ?? null,
        ...(session.session?.id ? { sessionId: session.session.id } : {}),
        ...(created && !Number.isNaN(created.getTime())
          ? { sessionCreatedAt: created }
          : {}),
      };
    },
  };
}
