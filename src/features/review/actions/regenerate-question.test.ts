import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  requestRegeneration: vi.fn(),
  audit: vi.fn(() => Promise.resolve(true)),
  scheduleRun: vi.fn(),
}));

vi.mock("@/features/auth/service/guard", () => ({
  authorizeAction: mocks.authorizeAction,
}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => ({ db: true }) }));
vi.mock("@/features/generation/service/regenerate", () => ({
  requestRegeneration: mocks.requestRegeneration,
}));
vi.mock("@/lib/events", () => ({ audit: mocks.audit }));
vi.mock("@/lib/jobs/trigger", () => ({ scheduleRun: mocks.scheduleRun }));

import { logger } from "@/lib/logger";
import { regenerateQuestionAction } from "./regenerate-question";

const USER = {
  status: "allowed" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  email: "t@example.test",
  displayName: null,
};
const QUESTION_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeAction.mockResolvedValue({ ok: true, data: USER });
  mocks.requestRegeneration.mockResolvedValue({
    ok: true,
    data: { jobId: JOB_ID, deferredUntil: null },
  });
});

describe("regenerateQuestionAction", () => {
  it("answers signed_out without touching the database when nobody is signed in", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(
      await regenerateQuestionAction({ questionId: QUESTION_ID, hint: null }),
    ).toEqual({ ok: false, reason: "signed_out" });
    expect(mocks.requestRegeneration).not.toHaveBeenCalled();
  });

  it("refuses a malformed request before the database", async () => {
    for (const raw of [
      { questionId: "nope", hint: null },
      { questionId: QUESTION_ID, hint: "louder" },
      { questionId: QUESTION_ID, hint: { text: 5 } },
      { questionId: QUESTION_ID },
    ]) {
      expect(await regenerateQuestionAction(raw)).toEqual({
        ok: false,
        reason: "generic",
      });
    }
    expect(mocks.requestRegeneration).not.toHaveBeenCalled();
  });

  it("queues as the signed-in owner, audits the hint kind only and starts the runner", async () => {
    const text = "Pakai konteks pasar.";
    const result = await regenerateQuestionAction({
      questionId: QUESTION_ID,
      hint: { text },
      ownerId: "someone-else",
    });
    expect(result).toEqual({ ok: true, jobId: JOB_ID, deferredUntil: null });
    expect(mocks.requestRegeneration).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({
        ownerId: USER.userId,
        questionId: QUESTION_ID,
        hint: { text },
      }),
    );
    expect(mocks.audit).toHaveBeenCalledWith({
      ownerId: USER.userId,
      action: "question_regeneration_requested",
      entityType: "question",
      entityId: QUESTION_ID,
      metadata: { hint: "text", deferred: false },
    });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(text);
    expect(mocks.scheduleRun).toHaveBeenCalledTimes(1);
  });

  it("does not start the runner for a job deferred by the AI quota", async () => {
    const resume = new Date("2026-11-09T02:00:00.000Z");
    mocks.requestRegeneration.mockResolvedValue({
      ok: true,
      data: { jobId: JOB_ID, deferredUntil: resume },
    });
    expect(
      await regenerateQuestionAction({ questionId: QUESTION_ID, hint: "easier" }),
    ).toEqual({ ok: true, jobId: JOB_ID, deferredUntil: resume.toISOString() });
    expect(mocks.scheduleRun).not.toHaveBeenCalled();
  });

  it("passes the daily limit with its reset time, and the pending job to follow", async () => {
    const resetsAt = new Date("2026-11-08T17:00:00.000Z");
    mocks.requestRegeneration.mockResolvedValueOnce({
      ok: false,
      error: { reason: "daily_limit", limit: 30, used: 30, remaining: 0, resetsAt },
    });
    expect(
      await regenerateQuestionAction({ questionId: QUESTION_ID, hint: null }),
    ).toEqual({
      ok: false,
      reason: "daily_limit",
      limit: 30,
      used: 30,
      remaining: 0,
      resetsAt: resetsAt.toISOString(),
    });
    mocks.requestRegeneration.mockResolvedValueOnce({
      ok: false,
      error: { reason: "pending", jobId: JOB_ID },
    });
    expect(
      await regenerateQuestionAction({ questionId: QUESTION_ID, hint: null }),
    ).toEqual({ ok: false, reason: "pending", jobId: JOB_ID });
    for (const reason of ["not_found", "trashed", "not_ready"]) {
      mocks.requestRegeneration.mockResolvedValueOnce({ ok: false, error: { reason } });
      expect(
        await regenerateQuestionAction({ questionId: QUESTION_ID, hint: null }),
      ).toEqual({ ok: false, reason });
    }
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.scheduleRun).not.toHaveBeenCalled();
  });

  it("answers generic and logs no SQL text when the database fails", async () => {
    const error = Object.assign(new Error("insert into jobs ... params: secret hint"), {
      code: "57P01",
    });
    mocks.requestRegeneration.mockRejectedValue(error);
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    expect(
      await regenerateQuestionAction({ questionId: QUESTION_ID, hint: null }),
    ).toEqual({ ok: false, reason: "generic" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret hint");
    spy.mockRestore();
  });
});
