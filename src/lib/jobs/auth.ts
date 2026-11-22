import { createHash, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

export const MIN_SECRET_LENGTH = 32;

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Fails closed: an unset or short secret authorises nobody. Comparing fixed-length digests with
 * timingSafeEqual avoids leaking the secret through response timing.
 */
export function isRunnerAuthorized(
  header: string | null,
  secret: string | undefined,
): boolean {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return false;
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match?.[1]) return false;
  return timingSafeEqual(digest(match[1]), digest(secret));
}

/**
 * The secret Vercel Cron (and a manual run) presents. Never throws: if the environment is invalid
 * the route simply rejects everything.
 */
export function readCronSecret(): string | undefined {
  try {
    return getEnv().CRON_SECRET;
  } catch {
    return undefined;
  }
}
