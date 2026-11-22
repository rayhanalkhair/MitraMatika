import { z } from "zod";
import type { JobStatusValue, PublicJobStatus } from "../status";

const statusSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "deferred", "cancelled"]),
  progress: z.record(z.string(), z.unknown()).nullable(),
  error: z.object({ code: z.string() }).nullable(),
  runAfter: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function parseJobStatus(json: unknown): PublicJobStatus {
  return statusSchema.parse(json);
}

export function isTerminal(status: JobStatusValue): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

// 2 s while work is expected soon, 15 s while waiting for a quota reset, none once finished.
export function nextPollInterval(status: JobStatusValue): number | false {
  if (isTerminal(status)) return false;
  return status === "deferred" ? 15_000 : 2_000;
}

export type JobStatusResult =
  { kind: "ok"; job: PublicJobStatus } | { kind: "signed-out" } | { kind: "not-found" };

// Polling cadence for a query state. A failed fetch (network, 5xx) keeps retrying every 15 s so
// the page does not stall on a stale status; signed-out, not-found and no data stop polling.
export function pollIntervalFor(state: {
  status: "pending" | "error" | "success";
  data?: JobStatusResult;
}): number | false {
  if (state.status === "error") return 15_000;
  const data = state.data;
  return data?.kind === "ok" ? nextPollInterval(data.job.status) : false;
}

// A request that hangs (a cold function, a stalled connection) would keep the query "fetching" for
// good, and TanStack Query never starts a second fetch meanwhile, so the page would show a stale
// status with no error. Aborting turns it into a failed fetch that the poll then retries.
export const JOB_STATUS_TIMEOUT_MS = 10_000;

export async function fetchJobStatus(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobStatusResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, JOB_STATUS_TIMEOUT_MS);
  // The timer covers the headers and the body: a stalled body must abort too.
  try {
    const response = await fetchImpl(`/api/jobs/${id}`, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
      // The proxy answers an expired session with a redirect to the sign-in page; do not follow it.
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.type === "opaqueredirect") return { kind: "signed-out" };
    if (response.status >= 300 && response.status < 400) return { kind: "signed-out" };
    if (response.status === 401 || response.status === 403) return { kind: "signed-out" };
    if (response.status === 404) return { kind: "not-found" };
    if (!response.ok)
      throw new Error(`Job status request failed (${String(response.status)})`);
    return { kind: "ok", job: parseJobStatus(await response.json()) };
  } finally {
    clearTimeout(timer);
  }
}
