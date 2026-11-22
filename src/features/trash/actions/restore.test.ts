import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  service: vi.fn(),
  audit: vi.fn(() => Promise.resolve(true)),
  revalidatePath: vi.fn(),
}));

vi.mock("@/features/auth/service/guard", () => ({
  authorizeAction: mocks.authorizeAction,
}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../service/trash", () => ({ restoreQuestion: mocks.service }));
vi.mock("@/lib/events", () => ({ audit: mocks.audit }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { logger } from "@/lib/logger";
import { restoreQuestionAction } from "./restore";

const USER = {
  status: "allowed" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  email: "t@example.test",
  displayName: null,
};
const QUESTION_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeAction.mockResolvedValue({ ok: true, data: USER });
  mocks.service.mockResolvedValue({ ok: true, data: undefined });
});

describe("restoreQuestionAction", () => {
  it("answers signed_out without touching the database when nobody is signed in", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(await restoreQuestionAction({ questionId: QUESTION_ID })).toEqual({
      ok: false,
      reason: "signed_out",
    });
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it("refuses a malformed request before the database", async () => {
    expect(await restoreQuestionAction({ questionId: "x" })).toEqual({
      ok: false,
      reason: "generic",
    });
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it("acts as the signed-in owner only, audits ids only and refreshes the trash, bank and home", async () => {
    expect(
      await restoreQuestionAction({ questionId: QUESTION_ID, ownerId: "someone-else" }),
    ).toEqual({ ok: true });
    expect(mocks.service).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ ownerId: USER.userId, questionId: QUESTION_ID }),
    );
    expect(mocks.audit).toHaveBeenCalledWith({
      ownerId: USER.userId,
      action: "question_untrashed",
      entityType: "question",
      entityId: QUESTION_ID,
    });
    for (const path of ["/trash", "/question-bank", "/home"]) {
      expect(mocks.revalidatePath).toHaveBeenCalledWith(path);
    }
  });

  it.each([
    ["notFound", "not_found"],
    ["notInTrash", "not_in_trash"],
  ])("maps %s to %s and audits nothing", async (error, reason) => {
    mocks.service.mockResolvedValue({ ok: false, error });
    expect(await restoreQuestionAction({ questionId: QUESTION_ID })).toEqual({
      ok: false,
      reason,
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("answers generic and logs no SQL when the database fails", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    mocks.service.mockRejectedValue(
      Object.assign(new Error("insert ... params: secret stem"), { code: "40001" }),
    );
    expect(await restoreQuestionAction({ questionId: QUESTION_ID })).toEqual({
      ok: false,
      reason: "generic",
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret stem");
    error.mockRestore();
  });
});
