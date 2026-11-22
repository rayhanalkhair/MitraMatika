import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@/lib/result";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  requestExport: vi.fn(),
  scheduleRun: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/features/auth", () => ({ authorizeAction: mocks.authorize }));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => ({ db: true }) }));
vi.mock("@/lib/jobs/trigger", () => ({ scheduleRun: mocks.scheduleRun }));
vi.mock("@/lib/logger", () => ({
  logger: { error: mocks.logError, warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../service/request-export", () => ({ requestExport: mocks.requestExport }));

import { startExportAction } from "./start-export";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ASSESSMENT = "44444444-4444-4444-8444-444444444444";
const JOB = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(
    ok({ status: "allowed", userId: OWNER, email: "a@example.test", displayName: null }),
  );
});

describe("startExportAction", () => {
  it("refuses without a session and queues nothing", async () => {
    mocks.authorize.mockResolvedValue(err("unauthenticated"));
    expect(await startExportAction({ assessmentId: ASSESSMENT })).toEqual({
      ok: false,
      reason: "signedOut",
    });
    expect(mocks.requestExport).not.toHaveBeenCalled();
  });

  it("refuses a malformed id before any query", async () => {
    for (const raw of [null, "x", { assessmentId: "nope" }]) {
      expect(await startExportAction(raw)).toEqual({ ok: false, reason: "notFound" });
    }
    expect(mocks.requestExport).not.toHaveBeenCalled();
  });

  it("queues the export as the signed-in teacher and starts the runner", async () => {
    mocks.requestExport.mockResolvedValue(ok({ jobId: JOB }));
    expect(
      await startExportAction({ assessmentId: ASSESSMENT, ownerId: "someone-else" }),
    ).toEqual({ ok: true, jobId: JOB });
    expect(mocks.requestExport).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ ownerId: OWNER, assessmentId: ASSESSMENT }),
    );
    expect(mocks.scheduleRun).toHaveBeenCalledTimes(1);
  });

  it("still answers ok when the runner cannot be scheduled (a poll, a kick or the daily run picks the job up)", async () => {
    mocks.requestExport.mockResolvedValue(ok({ jobId: JOB }));
    mocks.scheduleRun.mockImplementation(() => {
      throw new Error("outside a request");
    });
    expect(await startExportAction({ assessmentId: ASSESSMENT })).toEqual({
      ok: true,
      jobId: JOB,
    });
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it.each(["notApproved", "stale", "notFound"] as const)(
    "refuses an assessment the gate refuses (%s) without starting the runner",
    async (reason) => {
      mocks.requestExport.mockResolvedValue(err({ reason }));
      expect(await startExportAction({ assessmentId: ASSESSMENT })).toEqual({
        ok: false,
        reason,
      });
      expect(mocks.scheduleRun).not.toHaveBeenCalled();
    },
  );

  it("answers with the pending job instead of a second one", async () => {
    mocks.requestExport.mockResolvedValue(err({ reason: "pending", jobId: JOB }));
    expect(await startExportAction({ assessmentId: ASSESSMENT })).toEqual({
      ok: false,
      reason: "pending",
      jobId: JOB,
    });
    expect(mocks.scheduleRun).not.toHaveBeenCalled();
  });

  it("passes the hourly cap on with the reset time as an ISO string", async () => {
    mocks.requestExport.mockResolvedValue(
      err({
        reason: "hourlyLimit",
        limit: 10,
        resetsAt: new Date("2026-11-20T04:30:00.000Z"),
      }),
    );
    expect(await startExportAction({ assessmentId: ASSESSMENT })).toEqual({
      ok: false,
      reason: "hourlyLimit",
      limit: 10,
      resetsAt: "2026-11-20T04:30:00.000Z",
    });
  });

  it("answers generic when the database fails", async () => {
    mocks.requestExport.mockRejectedValue(new Error("connection refused"));
    expect(await startExportAction({ assessmentId: ASSESSMENT })).toEqual({
      ok: false,
      reason: "generic",
    });
  });
});
