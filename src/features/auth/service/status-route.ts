import "server-only";
import type { ActionAuthorization } from "@/features/auth/service/guard";
import { isUuid, type PublicJobStatus } from "@/lib/jobs/status";
import { logger } from "@/lib/logger";

const NO_STORE = { "Cache-Control": "no-store" };

export interface StatusDeps {
  authorize: () => Promise<ActionAuthorization>;
  readJob: (
    userId: string,
    id: string,
  ) => Promise<{ job: PublicJobStatus; due?: boolean } | PublicJobStatus | null>;
  /**
   * Starts the runner (after the response). Called only for a due job of the signed-in teacher,
   * at most once per job per KICK_INTERVAL_MS on this server instance.
   */
  kick?: () => void;
  /** The clock, in milliseconds. Tests inject one. */
  now?: () => number;
}

const notFound = () =>
  Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

export const KICK_INTERVAL_MS = 30_000;
const KICK_FORGET_MS = 300_000;

// Last kick per job id, in this instance's memory only (no column, no schema). Entries older than
// KICK_FORGET_MS are dropped on every call, so the map cannot grow without bound.
const lastKick = new Map<string, number>();

export function kickThrottleSize(): number {
  return lastKick.size;
}

export function resetKickThrottle(): void {
  lastKick.clear();
}

// Why a GET may start work: it only advances work that is ALREADY due, it needs the owner's
// authenticated session (SameSite=Lax cookies are not sent on cross-site subresource requests),
// and the runner is lease guarded, so a repeated or forged poll cannot do more than the daily
// run would. This app has a single teacher: revisit if a second tenant ever appears.
// A failed kick never fails the poll: the next poll or the daily run still picks the job up.
function kickRunner(
  kick: (() => void) | undefined,
  jobId: string,
  now: () => number,
): void {
  if (!kick) return;
  const at = now();
  for (const [id, when] of lastKick) {
    if (at - when > KICK_FORGET_MS) lastKick.delete(id);
  }
  const last = lastKick.get(jobId);
  if (last !== undefined && at - last < KICK_INTERVAL_MS) return;
  lastKick.set(jobId, at);
  try {
    kick();
  } catch (error) {
    logger.error(
      { module: "jobs", errorName: error instanceof Error ? error.name : "unknown" },
      "jobs: could not start the runner from a status poll",
    );
  }
}

export async function handleStatusRequest(
  id: string,
  deps: StatusDeps,
): Promise<Response> {
  const authorization = await deps.authorize();
  if (!authorization.ok) {
    return Response.json(
      { error: authorization.error },
      { status: 401, headers: NO_STORE },
    );
  }
  // A malformed id, a missing job and another teacher's job all look the same.
  if (!isUuid(id)) return notFound();

  try {
    const read = await deps.readJob(authorization.data.userId, id);
    if (!read) return notFound();
    const { job, due } = "job" in read ? read : { job: read, due: false };
    if (due) kickRunner(deps.kick, job.id, deps.now ?? Date.now);
    return Response.json(job, { headers: NO_STORE });
  } catch (error) {
    logger.error({ module: "jobs", err: error }, "jobs: status read failed");
    return Response.json({ error: "unavailable" }, { status: 500, headers: NO_STORE });
  }
}
