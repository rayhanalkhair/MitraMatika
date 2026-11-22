import "server-only";
import { getDb } from "@/lib/db/runtime";
import { requireBetterAuthSecret } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getObjectStore } from "@/lib/storage";
import { err, type Result } from "@/lib/result";
import {
  deleteAccountData,
  deleteAccountFor,
  type AccountDeletionError,
  type AccountDeletionRequest,
} from "./account-deletion";
import { deleteOwnerFiles } from "./account-files";
import {
  changePasswordFor,
  type PasswordChange,
  type PasswordChangeError,
} from "./password-change";
import { getAuthPort } from "./port-server";
import { readAccountSettings } from "./profile";

// The account settings services bound to the running app: the service connection, the auth
// secret and the request's auth port. Failures are logged by operation and error name only.

function logFailure(operation: string, error: unknown) {
  logger.error(
    { module: "settings", operation, err: error },
    `settings: ${operation} could not run`,
  );
}

/** changePasswordFor for the current request; a missing configuration is "generic". */
export async function changeAccountPassword(
  change: PasswordChange,
): Promise<Result<void, PasswordChangeError>> {
  try {
    return await changePasswordFor({ port: await getAuthPort() }, change);
  } catch (error) {
    logFailure("changePassword", error);
    return err("generic");
  }
}

/**
 * deleteAccountFor for the signed-in user (id, address and session age from the session) on the
 * service connection. Anything but a completed deletion leaves the account as it was.
 */
export async function deleteAccount(
  request: AccountDeletionRequest,
): Promise<Result<void, AccountDeletionError>> {
  try {
    const db = getDb();
    const secret = requireBetterAuthSecret();
    return await deleteAccountFor(
      {
        port: await getAuthPort(),
        hasPassword: async (userId) =>
          (await readAccountSettings(db, userId))?.hasPassword ?? null,
        deleteData: (owner) => deleteAccountData(db, { ...owner, secret }),
        // The account's logos and exports, after its rows (best effort, account-files.ts).
        deleteFiles: (userId) => deleteOwnerFiles(getObjectStore, userId),
      },
      request,
    );
  } catch (error) {
    logFailure("deleteAccount", error);
    return err("generic");
  }
}
