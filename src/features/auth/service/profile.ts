import "server-only";
import { and, eq, isNotNull } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AnyRelations } from "drizzle-orm/relations";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";
import { account, profiles, user } from "@/lib/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { nameSchema, schoolNameSchema } from "../schema/sign-up";
import type { AuthResult } from "../schema/types";

type Db<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
> = PgAsyncDatabase<TQueryResult, TRelations>;

export interface ProfileOwner {
  userId: string;
  email: string;
  displayName: string | null;
  /** Given at sign-up; blank or missing stores none. */
  schoolName?: string | null;
}

export function profileDisplayName(user: Pick<ProfileOwner, "email" | "displayName">) {
  const name = user.displayName?.trim();
  if (name) return name;
  return user.email.split("@")[0];
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

export async function insertProfile<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(db: PgAsyncDatabase<TQueryResult, TRelations>, user: ProfileOwner): Promise<void> {
  await db
    .insert(profiles)
    .values({
      id: user.userId,
      displayName: profileDisplayName(user),
      schoolName: blankToNull(user.schoolName),
    })
    .onConflictDoNothing({ target: profiles.id });
}

/**
 * Creates the profile row for a signed-in user if it is missing; an existing one is left as is.
 * Runs on the service connection, which bypasses RLS, so it writes only for exactly `user.userId`.
 */
export async function ensureProfile(user: ProfileOwner): Promise<AuthResult> {
  try {
    await insertProfile(getDb(), user);
    return ok();
  } catch {
    return err("generic");
  }
}

/** What the Settings "Akun" card shows. */
export interface AccountSettings {
  name: string;
  email: string;
  schoolName: string | null;
  /** True only with a password sign-in (a credential account holding a password). */
  hasPassword: boolean;
}

/** The account of `userId` (service connection, filtered by that id), or null if there is none. */
export async function readAccountSettings<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(db: Db<TQueryResult, TRelations>, userId: string): Promise<AccountSettings | null> {
  const rows = await db
    .select({ name: user.name, email: user.email, schoolName: profiles.schoolName })
    .from(user)
    .leftJoin(profiles, eq(profiles.id, user.id))
    .where(eq(user.id, userId));
  const row = rows.at(0);
  if (row === undefined) return null;
  const credentials = await db
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, "credential"),
        isNotNull(account.password),
      ),
    );
  return {
    name: row.name,
    email: row.email,
    schoolName: row.schoolName ?? null,
    hasPassword: credentials.length > 0,
  };
}

export interface AccountProfileUpdate {
  userId: string;
  name: string;
  /** Blank or missing clears it. */
  schoolName?: string | null;
}

/**
 * Saves the name and school of `userId` (decision 9). The name lives twice, as Better Auth's user
 * name (what the session and the app shell show) and as the profile's display name: both change
 * in one transaction, so they never disagree. The same limits as sign-up apply here too (2 to 80
 * characters, school up to 120), checked again whatever the caller did.
 */
export async function updateAccountProfile<
  TQueryResult extends PgQueryResultHKT,
  TRelations extends AnyRelations,
>(
  db: Db<TQueryResult, TRelations>,
  update: AccountProfileUpdate,
): Promise<Result<void, "invalid" | "notFound">> {
  const name = nameSchema.safeParse(update.name);
  const school = schoolNameSchema.safeParse(update.schoolName ?? undefined);
  if (!name.success || !school.success) return err("invalid");
  const schoolName = school.data ?? null;

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(user)
      .set({ name: name.data })
      .where(eq(user.id, update.userId))
      .returning({ id: user.id });
    if (updated.length === 0) return err("notFound");
    await tx
      .insert(profiles)
      .values({ id: update.userId, displayName: name.data, schoolName })
      .onConflictDoUpdate({
        target: profiles.id,
        set: { displayName: name.data, schoolName, updatedAt: new Date() },
      });
    return ok();
  });
}

/** readAccountSettings on the service connection; null when it cannot be read. */
export async function loadAccountSettings(
  userId: string,
): Promise<AccountSettings | null> {
  try {
    return await readAccountSettings(getDb(), userId);
  } catch (error) {
    logger.error(
      { module: "settings", operation: "loadAccount", err: error },
      "settings: the account could not be read",
    );
    return null;
  }
}

/** updateAccountProfile on the service connection; any failure is "generic". */
export async function saveAccountProfile(
  update: AccountProfileUpdate,
): Promise<Result<void, "generic">> {
  try {
    const result = await updateAccountProfile(getDb(), update);
    if (result.ok) return result;
    logger.warn(
      { module: "settings", operation: "saveProfile", code: result.error },
      "settings: the profile was not saved",
    );
    return err("generic");
  } catch (error) {
    logger.error(
      { module: "settings", operation: "saveProfile", err: error },
      "settings: the profile could not be saved",
    );
    return err("generic");
  }
}
