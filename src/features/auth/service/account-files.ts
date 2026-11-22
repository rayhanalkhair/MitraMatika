// The stored files of a deleted account (decision 9: the account and everything it owns). The
// rows go in deleteAccountData's transaction; the object store cannot join it, so the owner's
// folders, `templates/<ownerId>/` (school logos), `exports/<ownerId>/` (exported documents),
// `materials/<ownerId>/` (learning materials), `uploads/<ownerId>/` (uploads not finalised) and
// `solver/<ownerId>/` (solver photos), are
// deleted after the commit. Best effort: a storage failure is logged by counts only and never
// undoes or fails the deletion (the rows are gone, the account is gone). Export files would also
// go with the bucket's 8-day lifecycle rule; logos have none, so a failure leaves a logo for the
// runbook's manual cleanup ("Account deletion left files behind").
import { logger } from "@/lib/logger";
import { assertSafePrefix, type ObjectStore } from "@/lib/storage/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The roots of everything stored per owner (templates/service/logo.ts, export/service/file-names.ts, materials/service/upload.ts, solver/service/keys.ts). */
const OWNER_ROOTS = ["templates", "exports", "materials", "uploads", "solver"] as const;
/** One folder's deletion may take at most this long (it runs inside the Settings action). */
export const ACCOUNT_FILES_TIMEOUT_MS = 20_000;

/** The owner's folders, from the account id alone (a uuid); anything else throws. */
export function ownerFilePrefixes(ownerId: string): string[] {
  if (!UUID.test(ownerId)) throw new Error("account files: the owner id must be a uuid");
  return OWNER_ROOTS.map((root) => {
    const prefix = `${root}/${ownerId.toLowerCase()}/`;
    assertSafePrefix(prefix);
    return prefix;
  });
}

function within<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("account files: the object store took too long"));
    }, ms);
  });
  return Promise.race([call, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Deletes the owner's stored files, folder by folder, each bounded by `timeoutMs`. Never throws:
 * returns how many objects went and how many folders failed, and logs the counts (never the owner
 * id, the keys or the error message).
 */
export async function deleteOwnerFiles(
  store: () => ObjectStore,
  ownerId: string,
  options: { timeoutMs?: number } = {},
): Promise<{ deleted: number; failed: number }> {
  const timeoutMs = options.timeoutMs ?? ACCOUNT_FILES_TIMEOUT_MS;
  let deleted = 0;
  let failed = 0;
  const errors: string[] = [];
  let prefixes: string[];
  try {
    prefixes = ownerFilePrefixes(ownerId);
  } catch (error) {
    prefixes = [];
    failed = OWNER_ROOTS.length;
    errors.push(error instanceof Error ? error.name : typeof error);
  }
  for (const prefix of prefixes) {
    try {
      deleted += await within(store().deletePrefix(prefix), timeoutMs);
    } catch (error) {
      failed += 1;
      errors.push(error instanceof Error ? error.name : typeof error);
    }
  }
  if (failed > 0) {
    logger.error(
      { module: "settings", operation: "deleteAccountFiles", deleted, failed, errors },
      "settings: some stored files of a deleted account were not removed; see the runbook",
    );
  } else {
    logger.info(
      { module: "settings", operation: "deleteAccountFiles", deleted, failed },
      "settings: removed the stored files of a deleted account",
    );
  }
  return { deleted, failed };
}
