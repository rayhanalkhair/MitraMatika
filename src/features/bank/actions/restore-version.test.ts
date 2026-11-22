import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  restoreVersion: vi.fn(),
  audit: vi.fn(() => Promise.resolve(true)),
  revalidatePath: vi.fn(),
}));

vi.mock("@/features/auth/service/guard", () => ({
  authorizeAction: mocks.authorizeAction,
}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../service/versions", () => ({ restoreVersion: mocks.restoreVersion }));
vi.mock("@/lib/events", () => ({ audit: mocks.audit }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { logger } from "@/lib/logger";
import { restoreVersionAction } from "./restore-version";

const USER = {
  status: "allowed" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  email: "t@example.test",
  displayName: null,
};
const QUESTION_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const raw = { questionId: QUESTION_ID, versionId: VERSION_ID, expectedRowVersion: 4 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeAction.mockResolvedValue({ ok: true, data: USER });
  mocks.restoreVersion.mockResolvedValue({ ok: true, data: { versionId: "v3" } });
});

describe("restoreVersionAction", () => {
  it("answers signed_out without touching the database when nobody is signed in", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(await restoreVersionAction(raw)).toEqual({ ok: false, reason: "signed_out" });
    expect(mocks.restoreVersion).not.toHaveBeenCalled();
  });

  it("refuses a malformed request before the database", async () => {
    expect(await restoreVersionAction({ ...raw, versionId: "x" })).toEqual({
      ok: false,
      reason: "generic",
    });
    expect(await restoreVersionAction({ ...raw, expectedRowVersion: 0 })).toEqual({
      ok: false,
      reason: "generic",
    });
    expect(mocks.restoreVersion).not.toHaveBeenCalled();
  });

  it("restores as the signed-in owner, audits ids only and refreshes the bank", async () => {
    expect(await restoreVersionAction({ ...raw, ownerId: "someone-else" })).toEqual({
      ok: true,
      versionId: "v3",
    });
    expect(mocks.restoreVersion).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({
        ownerId: USER.userId,
        questionId: QUESTION_ID,
        versionId: VERSION_ID,
        expectedRowVersion: 4,
      }),
    );
    expect(mocks.audit).toHaveBeenCalledWith({
      ownerId: USER.userId,
      action: "question_restored",
      entityType: "question",
      entityId: QUESTION_ID,
      metadata: { fromVersionId: VERSION_ID, versionId: "v3" },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/question-bank/${QUESTION_ID}`);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/question-bank");
  });

  it("maps the refusals", async () => {
    for (const [error, reason] of [
      ["notFound", "not_found"],
      ["stale", "stale"],
      ["trashed", "trashed"],
      ["notReady", "not_ready"],
      ["current", "current"],
    ]) {
      mocks.restoreVersion.mockResolvedValueOnce({ ok: false, error });
      expect(await restoreVersionAction(raw)).toEqual({ ok: false, reason });
    }
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("answers generic and logs no SQL text when the database fails", async () => {
    mocks.restoreVersion.mockRejectedValue(
      Object.assign(new Error("insert ... Hitung rahasia"), { code: "57P01" }),
    );
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    expect(await restoreVersionAction(raw)).toEqual({ ok: false, reason: "generic" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("rahasia");
    spy.mockRestore();
  });
});
