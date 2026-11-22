// The Beranda read model. The caller applies `runAsUser`, so every statement also runs under RLS;
// each one names owner_id as well because the service connection does not enforce RLS.
// A fixed number of statements (at most four) whatever the number of rows.
// Undecided mirrors the review: a draft, or an approval that no longer matches the current version
// (regenerated after approval; the status stays "approved" but the teacher sees a draft again).
// Questions in the trash count nowhere.
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { generationRequests, jobs, questions } from "@/lib/db/schema";
import type { AnyDb } from "@/features/generation";
import { parseRequestSummary } from "@/features/generation";

export interface DashboardRequest {
  requestId: string;
  topicTitle: string | null;
  quantity: number | null;
  createdAt: string;
}
export type RunningItem = DashboardRequest & {
  jobStatus: "queued" | "running" | "deferred";
  runAfter: string | null;
  progress: { done: number; total: number } | null;
  messageKey: string | null;
};
export type PendingItem = DashboardRequest & { undecided: number; readyToSave: number };
export interface Dashboard {
  hasActivity: boolean;
  running: RunningItem[];
  pending: PendingItem[];
  bankedCount: number;
  // Every undecided draft of the teacher, not only those of the (capped) pending list.
  undecidedTotal: number;
}

const SECTION_LIMIT = 5;
// The newest requests examined: enough to find SECTION_LIMIT running and SECTION_LIMIT pending ones
// for a teacher who keeps her bank tidy. An older pending request outside this window is not listed;
// it stays reachable from its request page. `hasActivity` needs no extra statement: the newest
// window is empty only when the teacher has no request at all.
const WINDOW = 50;

const ACTIVE = ["queued", "running", "deferred"] as const;
type ActiveStatus = (typeof ACTIVE)[number];
const isActive = (status: string | null): status is ActiveStatus =>
  status !== null && (ACTIVE as readonly string[]).includes(status);

function parseProgress(progress: unknown): {
  progress: RunningItem["progress"];
  messageKey: string | null;
} {
  if (typeof progress !== "object" || progress === null || Array.isArray(progress)) {
    return { progress: null, messageKey: null };
  }
  const { done, total, messageKey } = progress as Record<string, unknown>;
  const valid =
    typeof done === "number" &&
    typeof total === "number" &&
    Number.isInteger(done) &&
    Number.isInteger(total) &&
    done >= 0 &&
    done <= total;
  return {
    progress: valid ? { done, total } : null,
    messageKey: typeof messageKey === "string" ? messageKey : null,
  };
}

export async function getDashboard(
  db: AnyDb,
  input: { ownerId: string },
): Promise<Dashboard> {
  const { ownerId } = input;
  const requests = await db
    .select({
      id: generationRequests.id,
      params: generationRequests.params,
      createdAt: generationRequests.createdAt,
      jobStatus: jobs.status,
      runAfter: jobs.runAfter,
      jobProgress: jobs.progress,
    })
    .from(generationRequests)
    .leftJoin(
      jobs,
      and(
        eq(jobs.id, generationRequests.jobId),
        eq(jobs.ownerId, generationRequests.ownerId),
      ),
    )
    .where(eq(generationRequests.ownerId, ownerId))
    .orderBy(desc(generationRequests.createdAt), desc(generationRequests.id))
    .limit(WINDOW);

  const requestIds = requests.filter((r) => !isActive(r.jobStatus)).map((r) => r.id);
  const counts =
    requestIds.length === 0
      ? []
      : await db
          .select({
            requestId: questions.generationRequestId,
            undecided:
              sql<number>`count(*) filter (where ${questions.currentVersionId} is not null and (${questions.status} = 'draft' or (${questions.status} = 'approved' and ${questions.approvedVersionId} is distinct from ${questions.currentVersionId} and ${questions.bankedAt} is null)))`.mapWith(
                Number,
              ),
            readyToSave:
              sql<number>`count(*) filter (where ${questions.status} = 'approved' and ${questions.approvedVersionId} = ${questions.currentVersionId} and ${questions.bankedAt} is null)`.mapWith(
                Number,
              ),
          })
          .from(questions)
          .where(
            and(
              eq(questions.ownerId, ownerId),
              inArray(questions.generationRequestId, requestIds),
              isNull(questions.deletedAt),
            ),
          )
          .groupBy(questions.generationRequestId);

  const banked = (
    await db
      .select({ n: count() })
      .from(questions)
      .where(
        and(
          eq(questions.ownerId, ownerId),
          eq(questions.status, "approved"),
          isNotNull(questions.bankedAt),
          isNull(questions.deletedAt),
          // Same as the bank (R19): a banked question stays counted while it is regenerated.
          isNotNull(questions.approvedVersionId),
        ),
      )
  ).at(0);

  // The same "undecided" definition as the pending list, over all requests whose job is not active.
  const undecidedTotal =
    (
      await db
        .select({ n: count() })
        .from(questions)
        .innerJoin(
          generationRequests,
          and(
            eq(generationRequests.id, questions.generationRequestId),
            eq(generationRequests.ownerId, questions.ownerId),
          ),
        )
        .leftJoin(
          jobs,
          and(
            eq(jobs.id, generationRequests.jobId),
            eq(jobs.ownerId, generationRequests.ownerId),
          ),
        )
        .where(
          and(
            eq(questions.ownerId, ownerId),
            isNull(questions.deletedAt),
            or(isNull(jobs.status), notInArray(jobs.status, [...ACTIVE])),
            sql`${questions.currentVersionId} is not null and (${questions.status} = 'draft' or (${questions.status} = 'approved' and ${questions.approvedVersionId} is distinct from ${questions.currentVersionId} and ${questions.bankedAt} is null))`,
          ),
        )
    ).at(0)?.n ?? 0;

  const countsById = new Map(counts.map((c) => [c.requestId, c]));
  const running: RunningItem[] = [];
  const pending: PendingItem[] = [];
  for (const row of requests) {
    const summary = parseRequestSummary(row.params);
    const base: DashboardRequest = {
      requestId: row.id,
      topicTitle: summary?.topicTitle ?? null,
      quantity: summary?.quantity ?? null,
      createdAt: row.createdAt.toISOString(),
    };
    if (isActive(row.jobStatus)) {
      if (running.length >= SECTION_LIMIT) continue;
      const parsed = parseProgress(row.jobProgress);
      running.push({
        ...base,
        jobStatus: row.jobStatus,
        runAfter:
          row.jobStatus === "deferred" && row.runAfter
            ? row.runAfter.toISOString()
            : null,
        progress: parsed.progress,
        messageKey: parsed.messageKey,
      });
      continue;
    }
    const c = countsById.get(row.id);
    if (!c || c.undecided + c.readyToSave === 0 || pending.length >= SECTION_LIMIT)
      continue;
    pending.push({ ...base, undecided: c.undecided, readyToSave: c.readyToSave });
  }

  return {
    hasActivity: requests.length > 0,
    running,
    pending,
    bankedCount: banked?.n ?? 0,
    undecidedTotal,
  };
}
