import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  getTopic: vi.fn(),
  createGenerationRequest: vi.fn(),
  usage: vi.fn(() => Promise.resolve(true)),
  audit: vi.fn(() => Promise.resolve(true)),
  scheduleRun: vi.fn(),
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  insertProfile: vi.fn(() => Promise.resolve()),
  insertValues: vi.fn(),
  decideQuestion: vi.fn(),
  bankApprovedQuestions: vi.fn(),
  runAsUser: vi.fn((_db: unknown, _id: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({ tx: true })),
  ),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/features/auth/service/guard", () => ({
  authorizeAction: mocks.authorizeAction,
}));
vi.mock("@/features/curriculum", () => ({
  getCurriculum: () => ({ getTopic: mocks.getTopic }),
}));
vi.mock("@/lib/db/runtime", () => ({
  getDb: () => ({
    insert: () => ({
      values: (row: unknown) => {
        mocks.insertValues(row);
        return { onConflictDoNothing: mocks.insertProfile };
      },
    }),
  }),
}));
vi.mock("@/features/generation/service/request", () => ({
  createGenerationRequest: mocks.createGenerationRequest,
}));
vi.mock("@/lib/db/client", () => ({ runAsUser: mocks.runAsUser }));
vi.mock("@/features/review/service/decision", () => ({
  decideQuestion: mocks.decideQuestion,
}));
vi.mock("@/features/bank/service/bank", () => ({
  bankApprovedQuestions: mocks.bankApprovedQuestions,
}));
vi.mock("@/lib/events", () => ({ usage: mocks.usage, audit: mocks.audit }));
vi.mock("@/lib/jobs/trigger", () => ({ scheduleRun: mocks.scheduleRun }));

import { createStaticTranslator } from "@/lib/i18n/translator";
import {
  bankApprovedAction,
  createGenerationRequestAction,
  decideQuestionAction,
} from "./create-request";
import { logger } from "@/lib/logger";

const USER = {
  status: "allowed" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  email: "t@example.test",
  displayName: null,
};
const TOPIC = {
  id: "44444444-4444-4444-8444-444444444444",
  stableKey: "spldv",
  title: "SPLDV",
  version: { id: "33333333-3333-4333-8333-333333333333" },
};

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
};
const valid = { grade: "8", topic: "spldv", count: "5", difficulty: "sedang" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeAction.mockResolvedValue({ ok: true, data: USER });
  mocks.getTopic.mockResolvedValue(TOPIC);
  mocks.createGenerationRequest.mockResolvedValue({
    ok: true,
    data: {
      requestId: "55555555-5555-4555-8555-555555555555",
      jobId: "66666666-6666-4666-8666-666666666666",
      deferredUntil: null,
    },
  });
});

describe("createGenerationRequestAction", () => {
  it("passes a material selection to the service and maps its refusal to the material field", async () => {
    const materialId = "77777777-7777-4777-8777-777777777777";
    mocks.createGenerationRequest.mockResolvedValue({
      ok: false,
      error: { reason: "material", error: "pages" },
    });
    const state = await createGenerationRequestAction(
      {},
      form({
        ...valid,
        source: "material",
        materialId,
        materialScope: "pages",
        pages: "2-3",
      }),
    );
    expect(mocks.createGenerationRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ownerId: USER.userId,
        material: { materialId, scope: "pages", pages: [2, 3] },
      }),
    );
    expect(state).toEqual({ fieldErrors: { material: "pagesUnavailable" } });

    mocks.createGenerationRequest.mockResolvedValue({
      ok: false,
      error: { reason: "material", error: "unrelated" },
    });
    expect(
      await createGenerationRequestAction(
        {},
        form({ ...valid, source: "material", materialId, materialScope: "all" }),
      ),
    ).toEqual({ fieldErrors: { material: "materialUnrelated" } });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("sends no material for a topic request", async () => {
    await expect(createGenerationRequestAction({}, form(valid))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(mocks.createGenerationRequest.mock.calls[0][1]).not.toHaveProperty("material");
  });

  it("returns the daily limit state without audit, usage or a runner trigger", async () => {
    mocks.createGenerationRequest.mockResolvedValue({
      ok: false,
      error: {
        reason: "daily_limit",
        limit: 30,
        used: 28,
        remaining: 2,
        resetsAt: new Date("2026-11-10T17:00:00.000Z"),
      },
    });
    const state = await createGenerationRequestAction({}, form(valid));
    expect(state).toEqual({
      dailyLimit: {
        limit: 30,
        used: 28,
        remaining: 2,
        resetsAt: "2026-11-10T17:00:00.000Z",
      },
    });
    expect(mocks.usage).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.scheduleRun).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller without touching anything", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    const state = await createGenerationRequestAction({}, form(valid));
    expect(state).toEqual({ error: "unauthenticated" });
    expect(mocks.getTopic).not.toHaveBeenCalled();
    expect(mocks.createGenerationRequest).not.toHaveBeenCalled();
  });

  it("returns field errors for invalid input and does nothing else", async () => {
    const state = await createGenerationRequestAction(
      {},
      form({ grade: "8", count: "9" }),
    );
    expect(state.fieldErrors).toEqual({ topic: "topik", count: "jumlah" });
    expect(mocks.getTopic).not.toHaveBeenCalled();
  });

  it("re-checks the material fields with the form's schema, only for a material source", async () => {
    const material = { source: "material", materialScope: "pages", pages: "3-1" };
    const refused = await createGenerationRequestAction(
      {},
      form({ ...valid, ...material, materialId: "55555555-5555-4555-8555-555555555555" }),
    );
    expect(refused).toEqual({ fieldErrors: { material: "pagesInvalid" } });
    expect(mocks.createGenerationRequest).not.toHaveBeenCalled();
    // The same page list under the topic source is ignored.
    await expect(
      createGenerationRequestAction({}, form({ ...valid, ...material, source: "topic" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.createGenerationRequest.mock.calls[0][1]).not.toHaveProperty("material");
  });

  it("shows a grade field error nobody can see as the generic error", async () => {
    const state = await createGenerationRequestAction({}, form({ ...valid, grade: "9" }));
    expect(state).toEqual({ error: "generic" });
    expect(mocks.getTopic).not.toHaveBeenCalled();
    expect(mocks.createGenerationRequest).not.toHaveBeenCalled();
  });

  it("keeps the other field errors next to the generic error when the grade is wrong", async () => {
    const state = await createGenerationRequestAction(
      {},
      form({ grade: "9", count: "9", topic: "spldv", difficulty: "sedang" }),
    );
    expect(state.error).toBe("generic");
    expect(state.fieldErrors).toEqual({ count: "jumlah" });
  });

  it("reports an unknown or inactive topic as a field error", async () => {
    mocks.getTopic.mockResolvedValue(null);
    const state = await createGenerationRequestAction({}, form(valid));
    // The action returns a message key; the form translates it.
    expect(state.fieldErrors?.topic).toBe("topicUnknown");
    const t = createStaticTranslator("generate.errors");
    expect(t("topicUnknown")).toMatch(/tidak ditemukan/);
    expect(mocks.createGenerationRequest).not.toHaveBeenCalled();
  });

  it("looks the topic up by grade 8 and the stable key, never a client id", async () => {
    await expect(createGenerationRequestAction({}, form(valid))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(mocks.getTopic).toHaveBeenCalledWith({ grade: 8, stableKey: "spldv" });
  });

  it("returns a generic error when the topic lookup throws", async () => {
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    mocks.getTopic.mockRejectedValue(new Error("db down"));
    const state = await createGenerationRequestAction({}, form(valid));
    expect(state).toEqual({ error: "generic" });
    expect(mocks.createGenerationRequest).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("returns the active request id instead of creating another", async () => {
    mocks.createGenerationRequest.mockResolvedValue({
      ok: false,
      error: {
        reason: "active_request",
        requestId: "77777777-7777-4777-8777-777777777777",
      },
    });
    const state = await createGenerationRequestAction({}, form(valid));
    expect(state).toEqual({ activeRequestId: "77777777-7777-4777-8777-777777777777" });
    expect(mocks.scheduleRun).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("still redirects and schedules once when the audit write reports failure", async () => {
    mocks.audit.mockResolvedValueOnce(false);
    await expect(createGenerationRequestAction({}, form(valid))).rejects.toThrow(
      "NEXT_REDIRECT:/generate/55555555-5555-4555-8555-555555555555",
    );
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRun).toHaveBeenCalledTimes(1);
  });

  describe("returnTo (the way back to an assessment editor)", () => {
    const editor = "/assessment-builder/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const requestPath = "/generate/55555555-5555-4555-8555-555555555555";

    it("carries an editor path to the status page", async () => {
      const back = `${editor}?since=2026-11-19T10%3A00%3A00.000Z`;
      await expect(
        createGenerationRequestAction({}, form({ ...valid, returnTo: back })),
      ).rejects.toThrow(
        `NEXT_REDIRECT:${requestPath}?returnTo=${encodeURIComponent(back)}`,
      );
    });

    it.each(["/question-bank", "https://evil.test/", `//evil.test${editor}`, ""])(
      "drops %j and redirects to the plain status page",
      async (returnTo) => {
        await expect(
          createGenerationRequestAction({}, form({ ...valid, returnTo })),
        ).rejects.toThrow(`NEXT_REDIRECT:${requestPath}`);
        expect(mocks.redirect).toHaveBeenCalledWith(requestPath);
      },
    );
  });

  it("creates the request with the pinned version, records usage, triggers the runner and redirects", async () => {
    await expect(createGenerationRequestAction({}, form(valid))).rejects.toThrow(
      "NEXT_REDIRECT:/generate/55555555-5555-4555-8555-555555555555",
    );
    expect(mocks.insertValues).toHaveBeenCalledWith({ id: USER.userId });
    expect(mocks.insertProfile).toHaveBeenCalledTimes(1);
    expect(mocks.insertProfile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createGenerationRequest.mock.invocationCallOrder[0],
    );
    expect(mocks.createGenerationRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ownerId: USER.userId,
        topic: { id: TOPIC.id, stableKey: "spldv", title: "SPLDV" },
        curriculumVersionId: TOPIC.version.id,
        quantity: 5,
        difficulty: "sedang",
      }),
    );
    expect(mocks.usage).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: USER.userId,
        event: "generation_requested",
        metadata: expect.objectContaining({ quantity: 5, deferred: false }) as unknown,
      }),
    );
    expect(mocks.audit).toHaveBeenCalledWith({
      ownerId: USER.userId,
      action: "generation_requested",
      entityType: "generation_request",
      entityId: "55555555-5555-4555-8555-555555555555",
      metadata: { quantity: 5, difficulty: "sedang", deferred: false },
    });
    expect(mocks.scheduleRun).toHaveBeenCalledTimes(1);
  });

  it("does not trigger the runner for a deferred request but still redirects", async () => {
    mocks.createGenerationRequest.mockResolvedValue({
      ok: true,
      data: {
        requestId: "55555555-5555-4555-8555-555555555555",
        jobId: "66666666-6666-4666-8666-666666666666",
        deferredUntil: new Date("2026-10-12T01:00:00.000Z"),
      },
    });
    await expect(createGenerationRequestAction({}, form(valid))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(mocks.scheduleRun).not.toHaveBeenCalled();
    expect(mocks.usage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ deferred: true }) as unknown,
      }),
    );
  });

  it("returns a generic error and hides the cause when the write fails", async () => {
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    mocks.createGenerationRequest.mockRejectedValue(
      new Error("connection string leaked"),
    );
    const state = await createGenerationRequestAction({}, form(valid));
    expect(state).toEqual({ error: "generic" });
    expect(JSON.stringify(state)).not.toContain("leaked");
    log.mockRestore();
  });

  it("still redirects when scheduling the runner throws", async () => {
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    mocks.scheduleRun.mockImplementation(() => {
      throw new Error("after() outside a request scope");
    });
    await expect(createGenerationRequestAction({}, form(valid))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    log.mockRestore();
  });
});

describe("decideQuestionAction", () => {
  const raw = {
    questionId: "77777777-7777-4777-8777-777777777777",
    versionId: "88888888-8888-4888-8888-888888888888",
    rowVersion: 2,
    action: "approve",
  };

  it("returns signed_out without touching the database", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(await decideQuestionAction(raw)).toEqual({ ok: false, reason: "signed_out" });
    expect(mocks.runAsUser).not.toHaveBeenCalled();
  });

  it("returns invalid for a malformed input", async () => {
    expect(await decideQuestionAction({ ...raw, rowVersion: 0 })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(mocks.runAsUser).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("decides under runAsUser and audits without the note", async () => {
    mocks.decideQuestion.mockResolvedValue({
      ok: true,
      data: { decision: "approved", rowVersion: 3, override: true, versionNo: 2 },
    });
    const result = await decideQuestionAction({
      ...raw,
      overrideNote: "catatan rahasia guru",
    });
    expect(result).toMatchObject({ ok: true, rowVersion: 3 });
    expect(mocks.runAsUser).toHaveBeenCalledWith(
      expect.anything(),
      USER.userId,
      expect.any(Function),
    );
    expect(mocks.decideQuestion).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({
        ownerId: USER.userId,
        questionId: raw.questionId,
        overrideNote: "catatan rahasia guru",
      }),
    );
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const entry = (mocks.audit.mock.calls as unknown[][])[0][0];
    expect(entry).toMatchObject({
      ownerId: USER.userId,
      action: "question_approved",
      entityType: "question",
      entityId: raw.questionId,
      metadata: { override: true, versionNo: 2 },
    });
    expect(JSON.stringify(entry)).not.toContain("catatan rahasia");
  });

  it("audits a reject with the version number only", async () => {
    mocks.decideQuestion.mockResolvedValue({
      ok: true,
      data: { decision: "rejected", rowVersion: 3, override: false, versionNo: 1 },
    });
    await decideQuestionAction({ ...raw, action: "reject" });
    expect((mocks.audit.mock.calls as unknown[][])[0][0]).toMatchObject({
      action: "question_rejected",
      metadata: { versionNo: 1 },
    });
  });

  it("passes a rule failure through and does not audit it", async () => {
    mocks.decideQuestion.mockResolvedValue({ ok: false, error: "invalid_note" });
    expect(await decideQuestionAction({ ...raw, overrideNote: " " })).toEqual({
      ok: false,
      reason: "invalid_note",
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("never logs the override note when the database error carries it", async () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const note = "CATATAN-RAHASIA-DI-LOG-98765";
    const failure = Object.assign(
      new Error(`Failed query: update "questions" params: {"note":"${note}"}`),
      {
        name: "DrizzleQueryError",
        cause: Object.assign(new Error(`params ${note}`), { code: "40001" }),
      },
    );
    mocks.decideQuestion.mockRejectedValue(failure);
    expect(await decideQuestionAction({ ...raw, overrideNote: note })).toEqual({
      ok: false,
      reason: "generic",
    });
    expect(spy).toHaveBeenCalled();
    const logged = spy.mock.calls.flat();
    expect(JSON.stringify(logged)).not.toContain(note);
    expect(logged.some((arg) => (arg as { err?: unknown } | null)?.err === failure)).toBe(
      false,
    );
    expect(logged).toContainEqual(
      expect.objectContaining({ err: { name: "DrizzleQueryError", code: "40001" } }),
    );
    spy.mockRestore();
  });

  it("returns generic and does not audit when the decision throws", async () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    mocks.decideQuestion.mockRejectedValue(new Error("db down"));
    expect(await decideQuestionAction(raw)).toEqual({ ok: false, reason: "generic" });
    expect(mocks.audit).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("bankApprovedAction", () => {
  const raw = { requestId: "55555555-5555-4555-8555-555555555555" };

  it("returns signed_out without touching the database", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    expect(await bankApprovedAction(raw)).toEqual({ ok: false, reason: "signed_out" });
    expect(mocks.runAsUser).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([[null], [{}], [{ requestId: "nope" }], ["x"]])(
    "returns invalid for a malformed request id (%j)",
    async (input) => {
      expect(await bankApprovedAction(input)).toEqual({ ok: false, reason: "invalid" });
      expect(mocks.runAsUser).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    },
  );

  it("saves under runAsUser and audits the count", async () => {
    mocks.bankApprovedQuestions.mockResolvedValue({ saved: 3 });
    expect(await bankApprovedAction(raw)).toEqual({ ok: true, saved: 3 });
    expect(mocks.runAsUser).toHaveBeenCalledWith(
      expect.anything(),
      USER.userId,
      expect.any(Function),
    );
    expect(mocks.bankApprovedQuestions).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({ ownerId: USER.userId, requestId: raw.requestId }),
    );
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith({
      ownerId: USER.userId,
      action: "questions_banked",
      entityType: "generation_request",
      entityId: raw.requestId,
      metadata: { count: 3 },
    });
  });

  it("does not audit when nothing was saved", async () => {
    mocks.bankApprovedQuestions.mockResolvedValue({ saved: 0 });
    expect(await bankApprovedAction(raw)).toEqual({ ok: true, saved: 0 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("returns generic and logs only a safe summary when the save throws", async () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const secret = "SECRET-PARAM-24680";
    const failure = Object.assign(new Error(`Failed query params ${secret}`), {
      name: "DrizzleQueryError",
      cause: Object.assign(new Error(secret), { code: "40001" }),
    });
    mocks.bankApprovedQuestions.mockRejectedValue(failure);
    expect(await bankApprovedAction(raw)).toEqual({ ok: false, reason: "generic" });
    expect(mocks.audit).not.toHaveBeenCalled();
    const logged = spy.mock.calls.flat();
    expect(JSON.stringify(logged)).not.toContain(secret);
    expect(logged.some((arg) => (arg as { err?: unknown } | null)?.err === failure)).toBe(
      false,
    );
    expect(logged).toContainEqual(
      expect.objectContaining({ err: { name: "DrizzleQueryError", code: "40001" } }),
    );
    spy.mockRestore();
  });
});
