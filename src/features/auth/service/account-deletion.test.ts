import { eq, getTableName, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { FIXTURE, seedFixtures } from "@/lib/db/test-fixtures";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createFakeEmailSender } from "@/lib/email/fake";
import { logger } from "@/lib/logger";
import {
  AUDIT_ACCOUNT_DELETED,
  auditSubject,
  deleteAccountData,
  deleteAccountFor,
} from "./account-deletion";
import { createFakeAuthPort } from "./fake-port";
import { createAuth } from "./auth-server";
import { CLIENT_IP_HEADER } from "./client-ip";
import {
  createPasswordAttemptLimiter,
  passwordAttemptIdentifier,
} from "./password-change";
import { createSendLimiter, sendLimitIdentifiers } from "./send-limit";
import { createSignInFailureLimiter, signInFailureIdentifier } from "./sign-in-limit";

const EMAIL_A = "a@example.test";
const EMAIL_B = "b@example.test";
const SECRET = "test-secret-".padEnd(40, "x");

beforeEach(() => {
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Every table of the app, read from the schema module: a table added later is covered without
// touching this file.
const TABLES = Object.values(schema as Record<string, unknown>).filter(
  (value): value is PgTable => is(value, PgTable),
);
const nameOf = (table: PgTable) => getTableName(table);

// The tables that hold no row of any account, each with the reason.
const NOT_OWNED: Record<string, string> = {
  curriculum_versions: "the shared curriculum catalogue",
  cp_elements: "the shared curriculum catalogue",
  topics: "the shared curriculum catalogue",
  learning_objectives: "the shared curriculum catalogue",
  verification:
    "Better Auth's tokens and the send/attempt limits: no foreign key, the deletion deletes the account's rows explicitly",
  rate_limit: "per-IP request counters; they name no account",
};
// Kept on deletion with the owner set to null (ON DELETE SET NULL).
// Kept on deletion with the owner set to null (ON DELETE SET NULL): error reports, the audit
// trail and the deletion log (ids and counts only) outlive the account, unlinked from it.
const ANONYMISED = ["app_errors", "audit_log", "deletion_log"];

/** Each row of `table` whose text (every column, as JSON) contains `needle`. */
async function rowsMentioning(t: TestDatabase, table: PgTable, needle: string) {
  const result = await t.db.execute(
    sql`select row_to_json(t)::text as row from ${table} as t
        where strpos(row_to_json(t)::text, ${needle}) > 0
        order by 1`,
  );
  return (result.rows as { row: string }[]).map((r) => r.row);
}

async function snapshot(t: TestDatabase, needle: string) {
  const out: Record<string, string[]> = {};
  for (const table of TABLES) out[nameOf(table)] = await rowsMentioning(t, table, needle);
  return out;
}

/**
 * A real pending password reset: /request-password-reset on the real Better Auth instance, which
 * stores the token row under a hashed identifier with the user id as the value. Returns that row.
 */
async function requestRealReset(t: TestDatabase, email: string, userId: string) {
  const before = new Set(
    (await t.db.select({ id: schema.verification.id }).from(schema.verification)).map(
      (row) => row.id,
    ),
  );
  const auth = createAuth({
    db: t.db,
    secret: SECRET,
    baseURL: "http://localhost:3000",
    google: null,
    getSender: () => createFakeEmailSender().send,
    // The email itself is not needed: only the token row the request stores.
    runInBackground: () => undefined,
    responseFloorsMs: {},
  });
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/request-password-reset", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        [CLIENT_IP_HEADER]: `198.51.100.${email === EMAIL_A ? "71" : "72"}`,
      },
      body: JSON.stringify({ email }),
    }),
  );
  expect(response.status).toBe(200);
  // The email work is never awaited here, but it may still run and write its limit rows (value
  // "1"); only the token row matters.
  const created = (await t.db.select().from(schema.verification)).filter(
    (row) => !before.has(row.id) && row.value !== "1",
  );
  expect(created).toHaveLength(1);
  // As stored by Better Auth: a hashed identifier with no readable prefix, the id as the value.
  expect(created[0].identifier.startsWith("reset-password")).toBe(false);
  expect(created[0].value).toBe(userId);
  return created[0];
}

/** Rows of user A that have no foreign key to the account: tokens and limits. */
async function seedUnlinkedRows(t: TestDatabase) {
  const inAnHour = new Date(Date.now() + 3_600_000);
  await requestRealReset(t, EMAIL_A, USER_A);
  await requestRealReset(t, EMAIL_B, USER_B);
  await t.db.insert(schema.verification).values([
    { identifier: EMAIL_A, value: "123456", expiresAt: inAnHour },
    {
      identifier: "oauth-state-a",
      value: JSON.stringify({ link: { email: EMAIL_A, userId: USER_A } }),
      expiresAt: inAnHour,
    },
    // B's, which must stay.
    { identifier: EMAIL_B, value: "654321", expiresAt: inAnHour },
  ]);
  // The per-user password attempt limit (hashed, names nobody).
  await createPasswordAttemptLimiter(t.db, SECRET).allow(USER_A);
  // The per-address email limits (hashed).
  await createSendLimiter(t.db, SECRET, "reset").allow(EMAIL_A);
  await createSendLimiter(t.db, SECRET, "accountExists").allow(EMAIL_A);
  await createSendLimiter(t.db, SECRET, "reset").allow(EMAIL_B);
  await createSignInFailureLimiter(t.db, SECRET).begin(EMAIL_A);
}

describe("account deletion (PGlite, real migrations)", () => {
  it("every table either belongs to an account through cascading foreign keys or is listed with a reason", () => {
    // A table belongs to an account when one of its foreign keys cascades from "user" or from a
    // table that does. A new owned table that forgets ON DELETE CASCADE ends up in neither group
    // and fails here; so does one whose owner column has no foreign key at all.
    const owned = new Set<string>(["user"]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const table of TABLES) {
        const name = nameOf(table);
        if (owned.has(name)) continue;
        const cascades = getTableConfig(table).foreignKeys.some(
          (fk) =>
            fk.onDelete === "cascade" &&
            owned.has(getTableName(fk.reference().foreignTable)),
        );
        if (cascades) {
          owned.add(name);
          grew = true;
        }
      }
    }
    const rest = TABLES.map(nameOf).filter(
      (name) => !owned.has(name) && !ANONYMISED.includes(name),
    );
    expect(rest.sort()).toEqual(Object.keys(NOT_OWNED).sort());

    // No foreign key into an account's rows may block the deletion (NO ACTION / RESTRICT)
    // unless it sits between two tables that both go with the account.
    for (const table of TABLES) {
      for (const fk of getTableConfig(table).foreignKeys) {
        const target = getTableName(fk.reference().foreignTable);
        if (!owned.has(target) || owned.has(nameOf(table))) continue;
        expect(
          ["cascade", "set null"].includes(fk.onDelete ?? "no action"),
          `${nameOf(table)} -> ${target}`,
        ).toBe(true);
      }
    }
  });

  it(
    "delete account removes the user and every owned row (questions, versions, generation requests, jobs), leaving another user's rows untouched",
    async () => {
      const t = await createTestDatabase();
      await seedFixtures(t.db);
      await seedUnlinkedRows(t);
      const beforeA = await snapshot(t, USER_A);
      const beforeB = await snapshot(t, USER_B);
      // The fixtures put a row of A in every owned table.
      for (const [table, rows] of Object.entries(beforeA)) {
        if (!(table in NOT_OWNED) || table === "verification") {
          expect(rows.length, table).toBeGreaterThan(0);
        }
      }

      const result = await deleteAccountData(t.db, {
        userId: USER_A,
        email: EMAIL_A,
        secret: SECRET,
      });
      expect(result).toEqual({
        ok: true,
        data: {
          sessions: 1,
          accounts: 1,
          questions: 1,
          questionVersions: 1,
          verificationRuns: 1,
          generationRequests: 1,
          generationRuns: 1,
          jobs: 1,
          aiCalls: 1,
        },
      });

      // No row in any table names A by id or by address.
      for (const table of TABLES) {
        expect(await rowsMentioning(t, table, USER_A), nameOf(table)).toEqual([]);
        expect(await rowsMentioning(t, table, EMAIL_A), nameOf(table)).toEqual([]);
      }
      // B's rows are exactly as they were.
      expect(await snapshot(t, USER_B)).toEqual(beforeB);
      // A's error report stays, anonymised.
      const [error] = await t.db
        .select({ ownerId: schema.appErrors.ownerId })
        .from(schema.appErrors)
        .where(eq(schema.appErrors.id, FIXTURE.appError(1)));
      expect(error.ownerId).toBeNull();

      // A's hashed limit rows are gone too; B's stay.
      const hashed = await t.db
        .select({ identifier: schema.verification.identifier })
        .from(schema.verification);
      const identifiers = hashed.map((row) => row.identifier);
      for (const identifier of [
        ...sendLimitIdentifiers(SECRET, EMAIL_A),
        passwordAttemptIdentifier(SECRET, USER_A),
        signInFailureIdentifier(SECRET, EMAIL_A),
      ]) {
        expect(identifiers).not.toContain(identifier);
      }
      expect(
        identifiers.filter((id) => sendLimitIdentifiers(SECRET, EMAIL_B).includes(id)),
      ).toHaveLength(2);

      // A's earlier audit rows survive, unlinked (S12).
      const [earlier] = await t.db
        .select({ ownerId: schema.auditLog.ownerId, action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.id, FIXTURE.audit(1)));
      expect(earlier).toEqual({ ownerId: null, action: "sign_in" });

      // One deletion entry: counts and a keyed hash of the id, no owner, no entity.
      const entries = await t.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, AUDIT_ACCOUNT_DELETED));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        ownerId: null,
        entityType: null,
        entityId: null,
        metadata: {
          ...(result.ok ? result.data : {}),
          subject: auditSubject(SECRET, USER_A),
        },
      });
      expect(auditSubject(SECRET, USER_A)).toMatch(/^[0-9a-f]{64}$/);
      expect(auditSubject(SECRET, USER_A)).not.toBe(auditSubject("other-secret", USER_A));
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "deletes verification rows by exact match only: another user's rows that merely contain the id or address stay",
    async () => {
      const t = await createTestDatabase();
      await seedFixtures(t.db);
      const inAnHour = new Date(Date.now() + 3_600_000);
      const others = [
        { identifier: `x-${EMAIL_A}`, value: "1" },
        { identifier: "note", value: `contains ${USER_A} somewhere` },
        { identifier: "hashed-token-other", value: `${USER_A}-not-quite` },
        { identifier: "hashed-token-b", value: USER_B },
        {
          identifier: "oauth-state-b",
          value: JSON.stringify({ userId: USER_B, note: USER_A }),
        },
        {
          identifier: "oauth-state-c",
          value: JSON.stringify({ link: { email: `${EMAIL_A}.other`, userId: USER_B } }),
        },
        { identifier: "not-json", value: `{"userId": "${USER_A}"` },
      ];
      const mine = [
        { identifier: "hashed-token-a", value: USER_A },
        { identifier: EMAIL_A, value: "1" },
        { identifier: "state-a", value: JSON.stringify({ userId: USER_A }) },
        {
          identifier: "link-a",
          value: JSON.stringify({ link: { email: EMAIL_A, userId: USER_A } }),
        },
      ];
      await t.db
        .insert(schema.verification)
        .values([...others, ...mine].map((row) => ({ ...row, expiresAt: inAnHour })));

      const result = await deleteAccountData(t.db, {
        userId: USER_A,
        email: EMAIL_A,
        secret: SECRET,
      });
      expect(result.ok).toBe(true);
      const left = await t.db
        .select({ identifier: schema.verification.identifier })
        .from(schema.verification);
      expect(left.map((row) => row.identifier).sort()).toEqual(
        others.map((row) => row.identifier).sort(),
      );
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "does nothing for an address that is not the account's, or an unknown account",
    async () => {
      const t = await createTestDatabase();
      await seedFixtures(t.db);
      const before = await snapshot(t, USER_A);
      expect(
        await deleteAccountData(t.db, { userId: USER_A, email: EMAIL_B, secret: SECRET }),
      ).toEqual({
        ok: false,
        error: "notFound",
      });
      expect(
        await deleteAccountData(t.db, {
          userId: "44444444-4444-4444-8444-444444444444",
          email: EMAIL_A,
          secret: SECRET,
        }),
      ).toEqual({ ok: false, error: "notFound" });
      expect(await snapshot(t, USER_A)).toEqual(before);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "runs in one transaction: when the audit entry cannot be written, nothing is deleted",
    async () => {
      const t = await createTestDatabase();
      await seedFixtures(t.db);
      await seedUnlinkedRows(t);
      const before = await snapshot(t, USER_A);
      await t.db.execute(sql`
        create function refuse_audit() returns trigger language plpgsql as
        $$ begin raise exception 'audit refused'; end $$`);
      await t.db.execute(sql`
        create trigger refuse_audit before insert on audit_log
        for each row execute function refuse_audit()`);

      await expect(
        deleteAccountData(t.db, { userId: USER_A, email: EMAIL_A, secret: SECRET }),
      ).rejects.toThrow();
      expect(await snapshot(t, USER_A)).toEqual(before);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    "the deleted user's session no longer works",
    async () => {
      const t = await createTestDatabase();
      const fake = createFakeEmailSender();
      const pending: Promise<unknown>[] = [];
      const auth = createAuth({
        db: t.db,
        secret: SECRET,
        baseURL: "http://localhost:3000",
        google: null,
        getSender: () => fake.send,
        runInBackground: (task) => {
          pending.push(task);
        },
        responseFloorsMs: {},
      });
      let ip = 1;
      const send = async (request: Request) => {
        const response = await auth.handler(request);
        while (pending.length > 0) await Promise.all(pending.splice(0));
        return response;
      };
      const post = (path: string, body: unknown) =>
        send(
          new Request(`http://localhost:3000/api/auth${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "http://localhost:3000",
              [CLIENT_IP_HEADER]: `198.51.100.${String(ip++)}`,
            },
            body: JSON.stringify(body),
          }),
        );
      const credentials = { email: "guru@example.test", password: "rahasia123" };
      await post("/sign-up/email", {
        acceptPrivacy: true,
        name: "Bu Guru",
        ...credentials,
      });
      const link = /https?:\/\/\S+\/verify-email\?\S+/.exec(fake.messages[0].text)?.[0];
      await send(
        new Request(link ?? "", { headers: { [CLIENT_IP_HEADER]: "198.51.100.200" } }),
      );
      const signedIn = await post("/sign-in/email", credentials);
      const cookie =
        /better-auth\.session_token=[^;]+/.exec(
          signedIn.headers.get("set-cookie") ?? "",
        )?.[0] ?? "";
      const headers = new Headers({ cookie });
      const live = await auth.api.getSession({ headers });
      expect(live?.user.email).toBe("guru@example.test");

      expect(
        (
          await deleteAccountData(t.db, {
            userId: live?.user.id ?? "",
            email: credentials.email,
            secret: SECRET,
          })
        ).ok,
      ).toBe(true);

      expect(await auth.api.getSession({ headers })).toBeNull();
      expect((await post("/sign-in/email", credentials)).status).toBe(401);
    },
    DB_TEST_TIMEOUT,
  );
});

describe("deleteAccountFor: a fresh credential first (S11)", () => {
  const NOW = Date.parse("2026-11-18T08:00:00Z");
  const deleted = { ok: true as const, data: {} as never };
  function deps(
    hasPassword: boolean | null,
    port = createFakeAuthPort(),
    deleteData = vi.fn(() => Promise.resolve(deleted)),
  ) {
    return {
      port,
      hasPassword: () => Promise.resolve(hasPassword),
      deleteData,
      now: () => NOW,
    };
  }
  const request = (extra: Partial<Parameters<typeof deleteAccountFor>[1]> = {}) => ({
    userId: USER_A,
    email: EMAIL_A,
    sessionCreatedAt: new Date(NOW - 60 * 60_000),
    currentPassword: "",
    ...extra,
  });

  it("a password account must confirm the password, and a wrong one deletes nothing", async () => {
    const d = deps(true);
    expect(await deleteAccountFor(d, request())).toEqual({
      ok: false,
      error: "passwordRequired",
    });
    const wrong = deps(
      true,
      createFakeAuthPort({ verifyPassword: { error: { code: "wrong_password" } } }),
    );
    expect(
      await deleteAccountFor(wrong, request({ currentPassword: "salah123" })),
    ).toEqual({ ok: false, error: "wrongPassword" });
    expect(wrong.deleteData).not.toHaveBeenCalled();

    const limited = deps(
      true,
      createFakeAuthPort({ verifyPassword: { error: { code: "rate_limited" } } }),
    );
    expect(
      await deleteAccountFor(limited, request({ currentPassword: "rahasia123" })),
    ).toEqual({ ok: false, error: "rateLimited" });
    expect(limited.deleteData).not.toHaveBeenCalled();

    const right = deps(true);
    expect(
      await deleteAccountFor(right, request({ currentPassword: "rahasia123" })),
    ).toEqual({ ok: true, data: undefined });
    expect(right.port.calls).toEqual([
      { method: "verifyPassword", args: [{ password: "rahasia123" }] },
    ]);
    expect(right.deleteData).toHaveBeenCalledWith({ userId: USER_A, email: EMAIL_A });
  });

  it("an account without a password needs no password with a session from the last 10 minutes", async () => {
    const d = deps(false);
    expect(
      await deleteAccountFor(
        d,
        request({ sessionCreatedAt: new Date(NOW - 9 * 60_000) }),
      ),
    ).toEqual({ ok: true, data: undefined });
    expect(d.port.calls).toEqual([]);
  });

  it("refuses an older or unknown session of an account without a password", async () => {
    for (const sessionCreatedAt of [new Date(NOW - 11 * 60_000), null, undefined]) {
      const d = deps(false);
      expect(await deleteAccountFor(d, request({ sessionCreatedAt }))).toEqual({
        ok: false,
        error: "signInAgain",
      });
      expect(d.deleteData).not.toHaveBeenCalled();
    }
  });

  it("deletes the stored files only after the rows went, and a storage failure undoes nothing (I4)", async () => {
    const order: string[] = [];
    const d = {
      ...deps(
        false,
        createFakeAuthPort(),
        vi.fn(() => {
          order.push("rows");
          return Promise.resolve(deleted);
        }),
      ),
      deleteFiles: vi.fn((userId: string) => {
        order.push(`files:${userId}`);
        return Promise.reject(new Error("R2 unavailable"));
      }),
    };
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    expect(
      await deleteAccountFor(d, request({ sessionCreatedAt: new Date(NOW) })),
    ).toEqual({ ok: true, data: undefined });
    expect(order).toEqual(["rows", `files:${USER_A}`]);

    // Nothing was deleted: no files are touched.
    const missing = {
      ...deps(
        false,
        createFakeAuthPort(),
        vi.fn(() =>
          Promise.resolve({ ok: false as const, error: "notFound" as const }),
        ) as unknown as ReturnType<typeof deps>["deleteData"],
      ),
      deleteFiles: vi.fn(() => Promise.resolve()),
    };
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(
      await deleteAccountFor(missing, request({ sessionCreatedAt: new Date(NOW) })),
    ).toEqual({ ok: false, error: "notFound" });
    expect(missing.deleteFiles).not.toHaveBeenCalled();
  });

  it("answers notFound for a missing account, and logs and answers generic when something throws", async () => {
    expect(await deleteAccountFor(deps(null), request())).toEqual({
      ok: false,
      error: "notFound",
    });
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const failing = deps(
      false,
      createFakeAuthPort(),
      vi.fn(() => Promise.reject(new Error("relation does not exist"))),
    );
    expect(
      await deleteAccountFor(failing, request({ sessionCreatedAt: new Date(NOW) })),
    ).toEqual({ ok: false, error: "generic" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({
      module: "settings",
      operation: "deleteAccount",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(EMAIL_A);
  });
});
