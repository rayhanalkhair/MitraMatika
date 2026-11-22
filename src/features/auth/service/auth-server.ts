import "server-only";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { getDb } from "@/lib/db/runtime";
import { getEmailSender, type SendEmail } from "@/lib/email";
import { getEnv, requireBetterAuthSecret, requireBetterAuthUrl } from "@/lib/env";
import { logger, sanitiseError } from "@/lib/logger";
import { EMAIL_MAX, nameSchema, schoolNameSchema } from "../schema/sign-up";
import {
  createAuthEmails,
  RESET_LINK_EXPIRES_IN_SECONDS,
  VERIFICATION_LINK_EXPIRES_IN_SECONDS,
} from "./auth-emails";
import { createAdminNotifier } from "./admin-notice";
import { runAfterResponse } from "./background";
import { CLIENT_IP_HEADER } from "./client-ip";
import { prepareGoogleLink } from "./link-guard";
import { createPasswordAttemptLimiter } from "./password-change";
import {
  checkPassword,
  PASSWORD_MAX,
  PASSWORD_MIN,
  type PasswordProblem,
} from "./password-policy";
import { insertProfile } from "./profile";
import { createIpDailyLimiter, IP_DAILY_CAPS } from "./ip-daily-limit";
import { createSignInFailureLimiter } from "./sign-in-limit";

// The code the account hooks below refuse with. Better Auth uses the same code for its own
// "verify your email first" answer.
export const EMAIL_NOT_VERIFIED = "EMAIL_NOT_VERIFIED";
// Better Auth reads the client address from this one header only. The port and the /api/auth
// route overwrite it with an address resolved from the platform (see client-ip.ts).
export const IP_ADDRESS_HEADERS = [CLIENT_IP_HEADER];

// Better Auth's built-in limiter, per client IP (IP_ADDRESS_HEADERS). The counters live in the
// database (the rate_limit table), so every serverless instance shares them. Better Auth 1.7.25
// has its own special rules (api/rate-limiter: 3 per 10 s on /sign-in*, /sign-up*,
// /change-password*, /change-email*; 3 per 60 s on /request-password-reset and
// /send-verification-email) and 100 per 10 s elsewhere; a custom rule replaces them. Every path
// the app uses gets one here, so none depends on a library default. Keys match the normalised
// path exactly, or as a wildcard pattern for the routes with a parameter.
export const RATE_LIMIT_RULES: Record<string, { window: number; max: number }> = {
  "/sign-up/email": { window: 60, max: 3 },
  "/sign-in/email": { window: 60, max: 5 },
  "/request-password-reset": { window: 60, max: 3 },
  "/reset-password": { window: 60, max: 5 },
  "/reset-password/*": { window: 60, max: 5 },
  "/send-verification-email": { window: 60, max: 3 },
  "/verify-email": { window: 60, max: 10 },
  "/sign-in/social": { window: 10, max: 3 },
  "/callback/*": { window: 60, max: 10 },
  "/sign-out": { window: 60, max: 10 },
  // Settings > Akun. Both check the current password, so they also share a per-user attempt
  // limit (PASSWORD_CHECK_PATHS below).
  "/change-password": { window: 60, max: 3 },
  "/verify-password": { window: 60, max: 3 },
};

// Every HTTP endpoint Better Auth 1.7.25 exposes, split by whether this app uses it. The app
// reaches: Google sign-in (then the OAuth callback), email and password sign-up and sign-in, the
// verification link and its resend, the password reset request, link and reset, the password
// change and the password check before an account deletion (Settings), and sign-out, all
// through auth.handler (the only path Better Auth rate-limits), plus Better Auth's own error
// page. Sessions are read with auth.api.getSession on the server, never over HTTP.
// auth-server.test.ts fails when a library upgrade adds an endpoint that is in neither list.
export const USED_AUTH_PATHS = [
  "/sign-in/social",
  "/callback/:id",
  "/sign-out",
  "/sign-up/email",
  "/sign-in/email",
  "/verify-email",
  "/send-verification-email",
  "/request-password-reset",
  "/reset-password",
  "/reset-password/:token",
  "/change-password",
  "/verify-password",
  "/error",
  "/ok",
] as const;

export const DISABLED_AUTH_PATHS = [
  "/account-info",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
  "/get-access-token",
  "/get-session",
  "/link-social",
  "/list-accounts",
  "/list-sessions",
  "/refresh-token",
  "/revoke-other-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/unlink-account",
  "/update-session",
  "/update-user",
];

type BetterAuthLog = (level: string, message: string, ...args: unknown[]) => void;

const isErrorLike = (value: unknown): value is object =>
  value instanceof Error ||
  (typeof value === "object" && value !== null && "message" in value);

/**
 * Better Auth's `logger.log`: its own output goes through the sanitising pino logger instead of
 * the default console.error(message, rawError), which would print a driver error with its SQL
 * and parameters. Only warn and error are forwarded. The message is redacted and capped, and the
 * first error-like argument goes through the `err` serializer (name, code, no query text); every
 * other argument is dropped.
 */
export function createBetterAuthLog(
  log: Pick<typeof logger, "warn" | "error"> = logger,
): BetterAuthLog {
  return (level, message, ...args) => {
    if (level !== "warn" && level !== "error") return;
    const fields: { module: string; err?: unknown } = { module: "better-auth" };
    const error = args.find(isErrorLike);
    if (error !== undefined) fields.err = error;
    // sanitiseError keeps no message for a query error: then the library's own message may quote
    // the query too, so it is withheld as well.
    const queryError =
      error !== undefined && !("message" in (sanitiseError(error) as object));
    const text = queryError ? "details withheld" : (sanitiseError(message) as string);
    log[level](fields, `better-auth: ${text}`);
  };
}

function notVerified(): APIError {
  return new APIError("FORBIDDEN", {
    code: EMAIL_NOT_VERIFIED,
    message: "This account's email address is not verified.",
  });
}

// Better Auth's default base path; the app mounts it at src/app/api/auth/[...all].
const AUTH_BASE_PATH = "/api/auth";

// The one endpoint allowed to create a user whose email is not verified yet.
const SIGN_UP_PATH = "/sign-up/email";

// What Better Auth hands a database hook as its second argument: the endpoint context of the
// request that is writing, or null outside one.
type HookContext = { path?: string; body?: unknown } | null | undefined;

// databaseHooks.user.create.before: a user is created with a verified email, with one exception:
// the email and password sign-up, whose users start unverified and get no session until they
// open the verification link (requireEmailVerification and the session guard below). Google
// creates its user from the profile's email_verified claim under /callback/:id, so an unverified
// Google profile never gets an account. (Better Auth refuses to link an unverified Google
// profile to an existing user because Google is not a trusted provider: see accountLinking.)
export function createUserCreateGuard() {
  return (user: { emailVerified?: unknown }, context: HookContext): Promise<void> =>
    user.emailVerified === true || context?.path === SIGN_UP_PATH
      ? Promise.resolve()
      : Promise.reject(notVerified());
}

const PASSWORD_CODES: Record<PasswordProblem, string> = {
  tooShort: "PASSWORD_TOO_SHORT",
  tooLong: "PASSWORD_TOO_LONG",
  needsLetterAndDigit: "PASSWORD_NEEDS_LETTER_AND_DIGIT",
};
export const INVALID_SIGN_UP = "INVALID_SIGN_UP";
export const INVALID_EMAIL = "INVALID_EMAIL";

// The routes whose body carries an address: one user per address, so it is trimmed and
// lower-cased before Better Auth looks it up (Better Auth only lower-cases, and not on every
// route).
const REQUEST_RESET_PATH = "/request-password-reset";
// The app page that sets the new password (Task 5).
export const RESET_PASSWORD_PAGE = "/reset-password";
const EMAIL_BODY_PATHS = new Set([
  SIGN_UP_PATH,
  "/sign-in/email",
  REQUEST_RESET_PATH,
  "/send-verification-email",
]);
const CHANGE_PASSWORD_PATH = "/change-password";
// The routes that set a password, and the body field that carries it (decision 2).
const NEW_PASSWORD_FIELD: Partial<Record<string, string>> = {
  [SIGN_UP_PATH]: "password",
  "/reset-password": "newPassword",
  [CHANGE_PASSWORD_PATH]: "newPassword",
};

const badRequest = (code: string, message: string) =>
  new APIError("BAD_REQUEST", { code, message });

/**
 * `hooks.before`: runs before every endpoint, after the rate limiter. Normalises the address,
 * applies the password policy (Better Auth checks only the length), and checks the sign-up name
 * (2 to 80 characters) and optional school name (up to 120). A reset request's `redirectTo` is
 * always set to the app's reset page (a same-origin path), so the link Better Auth builds leads
 * there too; it is overwritten, not removed, because Better Auth merges this output with defu,
 * which skips undefined values. A password change always revokes the account's other sessions.
 * A foreign `redirectTo` never gets this far: Better Auth's router
 * checks the raw body first and answers 403 INVALID_REDIRECT_URL, the same for every address.
 * None of these checks depends on whether the address has an account, so none of them can
 * reveal it.
 */
export function normaliseAuthRequest(
  path: string,
  body: unknown,
): { context: { body: Record<string, unknown> } } | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const fields = body as Record<string, unknown>;
  const changes: Record<string, unknown> = {};

  if (EMAIL_BODY_PATHS.has(path) && typeof fields.email === "string") {
    changes.email = fields.email.trim().toLowerCase();
    if ((changes.email as string).length > EMAIL_MAX) {
      throw badRequest(INVALID_EMAIL, "The email address is too long.");
    }
  }
  if (path === REQUEST_RESET_PATH) changes.redirectTo = RESET_PASSWORD_PAGE;
  // Decision 9: a password change always ends every other session of the account.
  if (path === CHANGE_PASSWORD_PATH) changes.revokeOtherSessions = true;
  const passwordField = NEW_PASSWORD_FIELD[path];
  const password = passwordField === undefined ? undefined : fields[passwordField];
  if (typeof password === "string") {
    const result = checkPassword(password);
    if (!result.ok) {
      throw badRequest(
        PASSWORD_CODES[result.error],
        "The password does not meet the policy.",
      );
    }
  }
  if (path === SIGN_UP_PATH) {
    const name = nameSchema.safeParse(fields.name);
    const school = schoolNameSchema.safeParse(fields.schoolName ?? undefined);
    // Consent to the privacy notice is part of the sign-up request itself (the port sends it once
    // the form has it), so a direct POST cannot skip it.
    if (!name.success || !school.success || fields.acceptPrivacy !== true) {
      throw badRequest(INVALID_SIGN_UP, "The name or school name is not valid.");
    }
    changes.name = name.data;
    changes.schoolName = school.data ?? null;
  }
  if (Object.keys(changes).length === 0) return undefined;
  return { context: { body: { ...fields, ...changes } } };
}

// The routes that check the signed-in user's current password: each call counts against that
// user (password-change.ts), whatever address it comes from.
export const PASSWORD_CHECK_PATHS: ReadonlySet<string> = new Set([
  CHANGE_PASSWORD_PATH,
  "/verify-password",
]);

export const TOO_MANY_ATTEMPTS = "TOO_MANY_ATTEMPTS";

/**
 * `hooks.before`: normaliseAuthRequest, then the per-user attempt limit on PASSWORD_CHECK_PATHS
 * and the per-IP daily caps on the routes that email a named address (ip-daily-limit.ts), and the
 * per-address password sign-in failure limit (sign-in-limit.ts). The user comes from the request's session; without one the
 * endpoint answers 401 itself and nothing is counted. A refusal is 429 TOO_MANY_ATTEMPTS, before
 * the password or the address is looked at, so it reveals nothing about an account.
 */
export function createRequestNormaliser(
  allowPasswordAttempt: (userId: string) => Promise<boolean>,
  limits: {
    /** The per-IP daily caps (ip-daily-limit.ts); an undefined IP is the shared no-IP key. */
    allowFromIp?: (path: string, ip: string | undefined) => Promise<boolean>;
    /** The per-address sign-in failure limit (sign-in-limit.ts): records the attempt. */
    beginSignIn?: (email: string) => Promise<boolean>;
  } = {},
) {
  return createAuthMiddleware(async (ctx) => {
    // A sign-up never sets a picture: Better Auth would store any `image` as sent, and a later
    // Google link keeps it (updateUserInfoOnLink is off). Removed from the request's own body,
    // since a value returned from this hook is merged over the original and cannot remove a key.
    if (ctx.path === SIGN_UP_PATH && typeof ctx.body === "object" && ctx.body !== null) {
      delete (ctx.body as Record<string, unknown>).image;
    }
    const normalised = normaliseAuthRequest(ctx.path, ctx.body);
    if (PASSWORD_CHECK_PATHS.has(ctx.path)) {
      const session = await getSessionFromCtx(ctx);
      if (session && !(await allowPasswordAttempt(session.user.id))) {
        throw tooManyAttempts("Too many password attempts. Try again later.");
      }
    }
    if (ctx.path === SIGN_IN_PATH && limits.beginSignIn) {
      const email = signInEmailOf(ctx.body);
      if (email !== undefined && !(await limits.beginSignIn(email))) {
        throw tooManyAttempts(
          "Too many failed sign-ins for this address. Try again later.",
        );
      }
    }
    if (ctx.path in IP_DAILY_CAPS && limits.allowFromIp) {
      const ip = ctx.headers?.get(CLIENT_IP_HEADER) ?? undefined;
      if (!(await limits.allowFromIp(ctx.path, ip))) {
        throw tooManyAttempts(
          "Too many requests from this network today. Try again later.",
        );
      }
    }
    return normalised;
  });
}

const SIGN_IN_PATH = "/sign-in/email";

const signInEmailOf = (body: unknown): string | undefined => {
  const email = (body as { email?: unknown } | null | undefined)?.email;
  return typeof email === "string" ? email.trim().toLowerCase() : undefined;
};

/**
 * `hooks.after`: a password sign-in that did not end in Better Auth's wrong-email-or-password
 * answer (401) gives back the attempt `hooks.before` recorded for its address, so only failures
 * stay counted (sign-in-limit.ts). The same for every address.
 */
export function createSignInSettler(settle: (email: string) => Promise<void>) {
  return createAuthMiddleware((ctx) =>
    settleSignInAttempt(ctx.path, ctx.body, ctx.context.returned, settle),
  );
}

/**
 * The body of createSignInSettler. Never throws: the sign-in has already been answered (a session
 * may exist and its cookie is set), and Better Auth would turn an error here into a 500. A failure
 * is logged and the attempt simply stays counted until its window ends (re-review N5).
 */
export async function settleSignInAttempt(
  path: string,
  body: unknown,
  returned: unknown,
  settle: (email: string) => Promise<void>,
): Promise<void> {
  if (path !== SIGN_IN_PATH) return;
  const email = signInEmailOf(body);
  if (email === undefined) return;
  if ((returned as { statusCode?: unknown } | undefined)?.statusCode === 401) return;
  try {
    await settle(email);
  } catch (error) {
    logger.error(
      { module: "auth", errorName: error instanceof Error ? error.name : "unknown" },
      "auth: a sign-in attempt could not be given back; it stays counted",
    );
  }
}

const isSignInRequest = (request: Request | undefined): boolean =>
  request !== undefined && new URL(request.url).pathname.endsWith(SIGN_IN_PATH);

// The resolved client IP the port or the /api/auth route put on the request (client-ip.ts).
const clientIpOf = (request: Request | undefined): string | undefined =>
  request?.headers.get(CLIENT_IP_HEADER) ?? undefined;

const tooManyAttempts = (message: string) =>
  new APIError("TOO_MANY_REQUESTS", { code: TOO_MANY_ATTEMPTS, message });

interface SignUpProfile {
  userId: string;
  email: string;
  name: string;
  schoolName: string | null;
}

// databaseHooks.user.create.after: a sign-up's profile row starts with its display name and
// school name. A failure is logged by name only and never fails the sign-up (that would tell a
// new address from an existing one); the profile is then created at the first sign-in.
export function createSignUpProfileWriter(
  write: (profile: SignUpProfile) => Promise<void>,
) {
  return async (
    user: { id: string; email: string; name: string },
    context: HookContext,
  ): Promise<void> => {
    if (context?.path !== SIGN_UP_PATH) return;
    const body = (context.body ?? {}) as { schoolName?: unknown };
    const school = schoolNameSchema.safeParse(body.schoolName ?? undefined);
    try {
      await write({
        userId: user.id,
        email: user.email,
        name: user.name,
        schoolName: school.success ? (school.data ?? null) : null,
      });
    } catch (error) {
      logger.error(
        { module: "auth", errorName: error instanceof Error ? error.name : "unknown" },
        "auth: the profile of a new sign-up could not be written",
      );
    }
  };
}

const VERIFY_EMAIL_PATH = "/verify-email";

/**
 * The places an account becomes verified, each handing the user id to `schedule` (the admin
 * notice, admin-notice.ts, which claims it once and only for a pending account, so scheduling
 * twice is harmless). Better Auth 1.7.25 calls `emailVerification.afterEmailVerification` at
 * runtime but its types do not expose it, so the password path uses `databaseHooks.user.update.after`
 * on /verify-email (that route is the only place the library verifies an email). A Google user is
 * created verified (user.create.after, any path but the sign-up), and a Google link to an existing
 * user may have just verified it in the pre-hijack guard (account.create.after, which runs after
 * the transaction commits). The hooks never throw and never wait: `schedule` is background work.
 */
export function createVerifiedAccountTriggers(schedule: (userId: string) => void) {
  const safely = (userId: string) => {
    try {
      schedule(userId);
    } catch (error) {
      logger.error(
        { module: "auth", errorName: error instanceof Error ? error.name : "unknown" },
        "auth: the admin notice could not be scheduled",
      );
    }
  };
  return {
    userCreated: (
      created: { id: string; emailVerified?: unknown },
      context: HookContext,
    ): Promise<void> => {
      if (context?.path !== SIGN_UP_PATH && created.emailVerified === true) {
        safely(created.id);
      }
      return Promise.resolve();
    },
    userUpdated: (
      updated: { id: string; emailVerified?: unknown },
      context: HookContext,
    ): Promise<void> => {
      if (context?.path === VERIFY_EMAIL_PATH && updated.emailVerified === true) {
        safely(updated.id);
      }
      return Promise.resolve();
    },
    accountCreated: (created: { providerId: string; userId: string }): Promise<void> => {
      if (created.providerId === "google") safely(created.userId);
      return Promise.resolve();
    },
  };
}

// databaseHooks.session.create.before: no session starts for a user whose email is not verified
// (or who cannot be found), whatever the sign-in method.
export function createSessionCreateGuard(
  findEmailVerified: (userId: string) => Promise<boolean | null>,
) {
  return async (session: { userId: string }): Promise<void> => {
    if ((await findEmailVerified(session.userId)) !== true) throw notVerified();
  };
}

// databaseHooks.account.create.before: the pre-hijack guard (decision 5). Better Auth creates a
// Google account row for a new Google user (verified, so this does nothing) or when it links a
// Google sign-in to an existing user with the same address, which it does only after Google has
// reported that address verified. If that existing user is unverified, `prepare` strips what it
// holds (prepareGoogleLink) before the link row is written. A failure fails the account creation,
// so Better Auth answers the callback with its error page and links nothing.
export function createGoogleLinkGuard(
  findEmailVerified: (userId: string) => Promise<boolean | null>,
  prepare: (userId: string) => Promise<void>,
) {
  return async (account: { providerId: string; userId: string }): Promise<void> => {
    if (account.providerId !== "google") return;
    if ((await findEmailVerified(account.userId)) !== false) return;
    await prepare(account.userId);
  };
}

// Google sends the address as the account has it; one user per address means it is trimmed and
// lower-cased before Better Auth looks it up or stores it.
function normaliseGoogleEmail(profile: { email?: unknown }): { email?: string } {
  return typeof profile.email === "string"
    ? { email: profile.email.trim().toLowerCase() }
    : {};
}

// The minimum time a response on these paths takes, measured from the moment the request reaches
// the handler. Sign-up does three more database writes (user, profile, credential account) for a
// new address than for an existing one, and a reset request writes a reset token for an existing
// address where an unknown one only reads, so without a floor their timing would tell them apart.
// The floor is comfortably above each path's worst case.
// /send-verification-email already has Better Auth's own 500 ms floor.
export const RESPONSE_FLOOR_MS: Partial<Record<string, number>> = {
  "/sign-up/email": 800,
  "/request-password-reset": 800,
};

/**
 * The link in the reset email: Better Auth's /reset-password/:token, which checks the token and
 * redirects to the app's reset page with `?token=...` (or `?error=INVALID_TOKEN` once it is used
 * or expired). It is built here from the configured base URL and the token alone, so it leads
 * to that one page even if the request's `redirectTo` were ever to reach Better Auth's own link.
 */
export function resetLinkFor(baseURL: string, token: string): string {
  const origin = new URL(baseURL).origin;
  return (
    `${origin}${AUTH_BASE_PATH}/reset-password/${encodeURIComponent(token)}` +
    `?callbackURL=${encodeURIComponent(RESET_PASSWORD_PAGE)}`
  );
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Wraps `auth.handler` so every response on a listed path (any outcome: success, a validation
 * error, a thrown error) takes at least its floor. The wait starts after the handler has
 * answered, so no database connection or transaction is held while waiting. Paths are matched
 * exactly below `basePath`.
 */
export function withResponseFloors(
  handler: (request: Request) => Promise<Response>,
  options: {
    basePath: string;
    floorsMs: Partial<Record<string, number>>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): (request: Request) => Promise<Response> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? realSleep;
  return async (request) => {
    const { pathname } = new URL(request.url);
    const floor = pathname.startsWith(`${options.basePath}/`)
      ? options.floorsMs[pathname.slice(options.basePath.length)]
      : undefined;
    if (floor === undefined || floor <= 0) return handler(request);
    const start = now();
    try {
      return await handler(request);
    } finally {
      const remaining = floor - (now() - start);
      if (remaining > 0) await sleep(remaining);
    }
  };
}

export interface AuthDeps<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
> {
  db: PgAsyncDatabase<TQueryResult, TRelations>;
  secret: string;
  baseURL: string;
  google: { clientId: string; clientSecret: string } | null;
  /** Where Better Auth's background work goes. Defaults to Next's after(); tests collect it. */
  runInBackground?: (task: Promise<unknown>) => void;
  /** The email sender. Defaults to getEmailSender() (Resend); tests pass the fake one. */
  getSender?: () => SendEmail;
  /** The clock of the per-address email limit. Tests inject one. */
  now?: () => Date;
  /** Response floors per auth path (RESPONSE_FLOOR_MS by default); tests lower them. */
  responseFloorsMs?: Partial<Record<string, number>>;
}

export function createAuth<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(deps: AuthDeps<TQueryResult, TRelations>) {
  // The account and session hooks read the user through Better Auth's own adapter, which joins
  // the transaction the write runs in (sign-up and the Google user's creation run in one): a
  // query on deps.db would not see the uncommitted user, and on a single connection would wait
  // for the transaction that is waiting for it.
  const built: {
    context?: Promise<{
      internalAdapter: {
        findUserById: (id: string) => Promise<{ emailVerified: boolean } | null>;
      };
    }>;
  } = {};
  const findEmailVerified = async (userId: string) => {
    if (built.context === undefined) throw new Error("auth: used before it was built");
    const found = await (await built.context).internalAdapter.findUserById(userId);
    return found?.emailVerified ?? null;
  };
  const runInBackground = deps.runInBackground ?? runAfterResponse;
  const adminNotifier = createAdminNotifier({
    db: deps.db,
    getSender: deps.getSender ?? getEmailSender,
    now: deps.now,
  });
  const verifiedTriggers = createVerifiedAccountTriggers((userId) => {
    runInBackground(adminNotifier.notify(userId));
  });
  const signInLimiter = createSignInFailureLimiter(deps.db, deps.secret, deps.now);
  const emails = createAuthEmails({
    db: deps.db,
    secret: deps.secret,
    appUrl: deps.baseURL,
    getSender: deps.getSender ?? getEmailSender,
    runInBackground,
    now: deps.now,
    allowFromIp: (path, ip) =>
      createIpDailyLimiter(deps.db, deps.secret, deps.now).allow(path, ip),
  });

  const writeSignUpProfile = createSignUpProfileWriter((profile) =>
    insertProfile(deps.db, {
      userId: profile.userId,
      email: profile.email,
      displayName: profile.name,
      schoolName: profile.schoolName,
    }),
  );

  const auth = betterAuth({
    appName: "MitraMatika",
    secret: deps.secret,
    baseURL: deps.baseURL,
    trustedOrigins: [new URL(deps.baseURL).origin],
    // Real transactions (postgres-js and PGlite both have them): a sign-up writes its user and
    // its password row in one, so a Google link can never run between the two and leave the
    // password on the account the pre-hijack guard has just verified.
    database: drizzleAdapter(deps.db, { provider: "pg", transaction: true }),
    advanced: {
      database: { generateId: "uuid" },
      // The dedicated header only: anything else a client sends is ignored.
      ipAddress: { ipAddressHeaders: [...IP_ADDRESS_HEADERS] },
      backgroundTasks: { handler: runInBackground },
      // Better Auth turns its origin and redirect checks off when NODE_ENV is "test"; they stay on
      // everywhere so the tests run the production checks.
      disableOriginCheck: false,
    },
    // A reset token is stored only as a hash (the link carries the token itself), so a copy of
    // the verification table cannot be used to reset a password.
    verification: {
      storeIdentifier: { default: "plain", overrides: { "reset-password:": "hashed" } },
    },
    // 404 over HTTP (auth.api calls on the server are unaffected). Matching is exact.
    disabledPaths: [...DISABLED_AUTH_PATHS],
    logger: { level: "warn", log: createBetterAuthLog() },
    telemetry: { enabled: false },
    socialProviders: deps.google
      ? {
          google: {
            clientId: deps.google.clientId,
            clientSecret: deps.google.clientSecret,
            prompt: "select_account",
            mapProfileToUser: normaliseGoogleEmail,
          },
        }
      : {},
    // Decisions 2, 3 and 5. Sign-up never signs in: the session starts when the verification
    // link is opened. An existing address gets Better Auth's generic answer (the same 200 and
    // body shape as a new one, the password still hashed) and the account-exists email instead.
    // Decision 4: a reset request answers the same for every address and emails a single-use link
    // valid 1 hour to an existing one (with a Google-only user, the reset creates the password).
    // A reset ends every session of the user and starts none; it does not verify the email, so
    // an unverified account still needs the verification link before it can sign in.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      onExistingUserSignUp: ({ user }) =>
        emails.sendAccountExistsEmail({ email: user.email }),
      resetPasswordTokenExpiresIn: RESET_LINK_EXPIRES_IN_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url, token }, request) => {
        // Better Auth's own link carries the redirect after the request hook; anything other
        // than the reset page means that hook did not apply.
        if (new URL(url).searchParams.get("callbackURL") !== RESET_PASSWORD_PAGE) {
          logger.error(
            { module: "auth" },
            "auth: a reset request kept a redirect other than the reset page",
          );
        }
        return emails.sendResetEmail({
          email: user.email,
          url: resetLinkFor(deps.baseURL, token),
          ip: clientIpOf(request),
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      // A correct password on an unverified account resends the link (the per-address limit
      // keeps it to one a minute) and answers EMAIL_NOT_VERIFIED.
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: VERIFICATION_LINK_EXPIRES_IN_SECONDS,
      // The resend on a sign-in (sendOnSignIn) counts against the per-IP daily resend cap: an
      // attacker's own unverified sign-ups could otherwise be signed in to again and again to
      // spend the app-wide email budget (re-review N1).
      sendVerificationEmail: ({ user, url }, request) =>
        emails.sendVerificationEmail({
          email: user.email,
          url,
          ip: clientIpOf(request),
          countAs: isSignInRequest(request) ? "/send-verification-email" : undefined,
        }),
    },
    // Decision 5: a Google sign-in links to the existing user with the same address, only when
    // Google reports that address verified. Google is deliberately NOT a trusted provider: Better
    // Auth would then link even when Google says the address is unverified. Better Auth's own gate
    // (requireLocalEmailVerified, default true) refuses the link when the local user is unverified,
    // which locks the address owner out of Google sign-in while someone squats the address with a
    // password; it is turned off and replaced by the pre-hijack guard (account.create.before),
    // which strips the unverified user's password and sessions before the link. The option is
    // marked deprecated in 1.7.25 (the gate is to become unconditional): if it goes, linking an
    // unverified user is refused again (fail closed) and auth-server-google.test.ts fails.
    // Different addresses never link, and a link never overwrites the user's name or picture.
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: false,
        requireLocalEmailVerified: false,
        allowDifferentEmails: false,
        updateUserInfoOnLink: false,
      },
    },
    hooks: {
      before: createRequestNormaliser(
        (userId) =>
          createPasswordAttemptLimiter(deps.db, deps.secret, deps.now).allow(userId),
        {
          allowFromIp: (path, ip) =>
            createIpDailyLimiter(deps.db, deps.secret, deps.now).allow(path, ip),
          beginSignIn: (email) => signInLimiter.begin(email),
        },
      ),
      after: createSignInSettler((email) => signInLimiter.settle(email)),
    },
    rateLimit: { enabled: true, storage: "database", customRules: RATE_LIMIT_RULES },
    databaseHooks: {
      user: {
        create: {
          before: createUserCreateGuard(),
          after: async (created, context) => {
            await writeSignUpProfile(created, context);
            await verifiedTriggers.userCreated(created, context);
          },
        },
        update: {
          after: (updated, context) => verifiedTriggers.userUpdated(updated, context),
        },
      },
      account: {
        create: {
          before: createGoogleLinkGuard(findEmailVerified, (userId) =>
            prepareGoogleLink(deps.db, { userId }),
          ),
          after: (created) => verifiedTriggers.accountCreated(created),
        },
      },
      session: { create: { before: createSessionCreateGuard(findEmailVerified) } },
    },
    plugins: [
      // Must stay last: it copies Set-Cookie from auth.api calls into Next's cookie store.
      nextCookies(),
    ],
  });
  built.context = auth.$context;
  // Every caller (the /api/auth route and the auth port) goes through auth.handler.
  auth.handler = withResponseFloors(auth.handler, {
    basePath: AUTH_BASE_PATH,
    floorsMs: deps.responseFloorsMs ?? RESPONSE_FLOOR_MS,
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;

function readGoogle(): AuthDeps<PgQueryResultHKT, AnyRelations>["google"] {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = getEnv();
  return GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
    ? { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }
    : null;
}

let instance: Auth | undefined;

// Built on first use, never at import: a missing variable must not take down the proxy, the
// health route or any module that merely imports this one. Throws (in Indonesian) while
// BETTER_AUTH_SECRET or BETTER_AUTH_URL is missing; nothing is cached until it succeeds.
export function getAuth(): Auth {
  instance ??= createAuth({
    db: getDb(),
    secret: requireBetterAuthSecret(),
    baseURL: requireBetterAuthUrl(),
    google: readGoogle(),
  });
  return instance;
}

export function resetAuthForTests(): void {
  instance = undefined;
}
