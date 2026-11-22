import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  editQuestion: vi.fn(),
  audit: vi.fn(() => Promise.resolve(true)),
  revalidatePath: vi.fn(),
}));

vi.mock("@/features/auth/service/guard", () => ({
  authorizeAction: mocks.authorizeAction,
}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => ({ db: true }) }));
vi.mock("../service/edit-question", () => ({ editQuestion: mocks.editQuestion }));
vi.mock("@/lib/events", () => ({ audit: mocks.audit }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { logger } from "@/lib/logger";
import { editQuestionAction } from "./edit-question";

const USER = {
  status: "allowed" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  email: "t@example.test",
  displayName: null,
};
const QUESTION_ID = "22222222-2222-4222-8222-222222222222";
// What the editor form sends: the steps as rows. The service gets them as plain strings.
const stored = {
  stemMd: "Hitung $1 + 1$.",
  options: [
    { label: "A", textMd: "1" },
    { label: "B", textMd: "2" },
    { label: "C", textMd: "3" },
    { label: "D", textMd: "4" },
  ],
  correctLabel: "B",
  answerDisplayMd: "2",
  explanationMd: "Jumlahkan.",
  steps: ["Tulis soalnya.", "Jumlahkan."],
};
const content = {
  ...stored,
  steps: stored.steps.map((textMd) => ({ textMd })),
};
const raw = { questionId: QUESTION_ID, expectedRowVersion: 3, content };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeAction.mockResolvedValue({ ok: true, data: USER });
  mocks.editQuestion.mockResolvedValue({
    ok: true,
    data: { versionId: "v2", status: "terverifikasi" },
  });
});

describe("editQuestionAction", () => {
  it("answers signed_out without touching the database when nobody is signed in", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(await editQuestionAction(raw)).toEqual({ ok: false, reason: "signed_out" });
    expect(mocks.editQuestion).not.toHaveBeenCalled();
  });

  it("answers invalid, with the fields, for a malformed request", async () => {
    // Nothing to mark in the form: a generic failure, not "check the marked fields".
    expect(await editQuestionAction({ ...raw, questionId: "nope" })).toEqual({
      ok: false,
      reason: "generic",
    });
    expect(
      await editQuestionAction({ ...raw, content: { ...content, stemMd: "" } }),
    ).toEqual({ ok: false, reason: "invalid", fields: ["stemMd"] });
    expect(mocks.editQuestion).not.toHaveBeenCalled();
  });

  it("names an invalid step by its row, as the form's field path", async () => {
    const steps = [{ textMd: "Satu." }, { textMd: "x".repeat(501) }];
    expect(await editQuestionAction({ ...raw, content: { ...content, steps } })).toEqual({
      ok: false,
      reason: "invalid",
      fields: ["steps.1.textMd"],
    });
    expect(
      await editQuestionAction({ ...raw, content: { ...content, steps: ["Satu."] } }),
    ).toMatchObject({ ok: false });
    expect(mocks.editQuestion).not.toHaveBeenCalled();
  });

  it("maps a step the service marks back to its row when blank rows were dropped", async () => {
    const steps = [{ textMd: "Satu." }, { textMd: "  " }, { textMd: "Dua." }];
    mocks.editQuestion.mockResolvedValue({
      ok: false,
      error: { code: "invalid", fields: ["steps.1", "options.2.textMd"] },
    });
    expect(await editQuestionAction({ ...raw, content: { ...content, steps } })).toEqual({
      ok: false,
      reason: "invalid_math",
      fields: ["steps.2.textMd", "options.2.textMd"],
    });
    expect(mocks.editQuestion).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({ content: { ...stored, steps: ["Satu.", "Dua."] } }),
    );
  });

  it("edits as the signed-in owner, never as an id the client sent", async () => {
    const result = await editQuestionAction({ ...raw, ownerId: "someone-else" });
    expect(result).toEqual({ ok: true, versionId: "v2", status: "terverifikasi" });
    expect(mocks.editQuestion).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({
        ownerId: USER.userId,
        questionId: QUESTION_ID,
        expectedRowVersion: 3,
        content: stored,
      }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: USER.userId,
        action: "question_edited",
        entityType: "question",
        entityId: QUESTION_ID,
        metadata: { status: "terverifikasi" },
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/question-bank/${QUESTION_ID}`);
  });

  it.each([
    [{ code: "notFound" }, { reason: "not_found" }],
    [{ code: "stale" }, { reason: "stale" }],
    [{ code: "trashed" }, { reason: "trashed" }],
    [{ code: "notReady" }, { reason: "not_ready" }],
    [{ code: "regenerating" }, { reason: "regenerating" }],
    [
      { code: "invalid", fields: ["options.2.textMd"] },
      { reason: "invalid_math", fields: ["options.2.textMd"] },
    ],
  ])("maps %j to %j and does not audit", async (error, expected) => {
    mocks.editQuestion.mockResolvedValue({ ok: false, error });
    expect(await editQuestionAction(raw)).toEqual({ ok: false, ...expected });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("answers generic and logs only a summary when the database throws", async () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    mocks.editQuestion.mockRejectedValue(
      Object.assign(new Error("insert ... Hitung rahasia"), { code: "XX000" }),
    );
    expect(await editQuestionAction(raw)).toEqual({ ok: false, reason: "generic" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("rahasia");
    spy.mockRestore();
  });
});
