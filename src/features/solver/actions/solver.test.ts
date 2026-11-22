import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeAction: vi.fn(),
  revalidatePath: vi.fn(),
  scheduleRun: vi.fn(),
  createTextSession: vi.fn(),
  startPhotoSession: vi.fn(),
  finalizePhotoSession: vi.fn(),
  confirmExtraction: vi.fn(),
  solveAgain: vi.fn(),
  requestAlternative: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/features/auth/service/guard", () => ({
  authorizeAction: mocks.authorizeAction,
}));
const database = { db: true };
const store = { store: true };
vi.mock("@/lib/db/runtime", () => ({ getDb: () => database }));
vi.mock("@/lib/storage", () => ({ getObjectStore: () => store }));
vi.mock("@/lib/jobs/trigger", () => ({ scheduleRun: mocks.scheduleRun }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/logger", () => ({ logger: { error: mocks.logError } }));
vi.mock("../service/sessions", () => ({
  createTextSession: mocks.createTextSession,
  startPhotoSession: mocks.startPhotoSession,
  finalizePhotoSession: mocks.finalizePhotoSession,
  confirmExtraction: mocks.confirmExtraction,
  solveAgain: mocks.solveAgain,
  requestAlternative: mocks.requestAlternative,
}));

import {
  confirmExtractionAction,
  finalizePhotoAction,
  requestAlternativeAction,
  solveAgainAction,
  solveTextAction,
  startPhotoAction,
} from "./solver";

const USER = {
  status: "allowed" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  email: "t@example.test",
  displayName: null,
};
const OTHER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const ANY_DATE: unknown = expect.any(Date);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeAction.mockResolvedValue({ ok: true, data: USER });
});

const sessionActions = [
  ["finalizePhotoAction", finalizePhotoAction, mocks.finalizePhotoSession],
  ["solveAgainAction", solveAgainAction, mocks.solveAgain],
  ["requestAlternativeAction", requestAlternativeAction, mocks.requestAlternative],
] as const;

describe("solver actions", () => {
  it("refuse a signed-out caller before any work", async () => {
    mocks.authorizeAction.mockResolvedValue({ ok: false, error: "unauthenticated" });
    const out = { ok: false, error: "unauthenticated" };
    expect(await solveTextAction({ text: "1+1" })).toEqual(out);
    expect(
      await startPhotoAction({ kind: "photo", mime: "image/png", size: 10 }),
    ).toEqual(out);
    expect(await confirmExtractionAction({ sessionId: SESSION, text: "x" })).toEqual(out);
    for (const [, action, service] of sessionActions) {
      expect(await action({ sessionId: SESSION })).toEqual(out);
      expect(service).not.toHaveBeenCalled();
    }
    expect(mocks.createTextSession).not.toHaveBeenCalled();
    expect(mocks.startPhotoSession).not.toHaveBeenCalled();
    expect(mocks.confirmExtraction).not.toHaveBeenCalled();
  });

  it("solves typed text as the signed-in teacher (never an owner from the client), then runs the job", async () => {
    mocks.createTextSession.mockResolvedValue({
      ok: true,
      data: { sessionId: SESSION, jobId: "j" },
    });
    expect(await solveTextAction({ text: "1+1", ownerId: OTHER })).toEqual({
      ok: true,
      sessionId: SESSION,
    });
    expect(mocks.createTextSession).toHaveBeenCalledWith(database, {
      ownerId: USER.userId,
      text: "1+1",
      now: ANY_DATE,
    });
    expect(mocks.scheduleRun).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/solve/${SESSION}`);
  });

  it("passes the service's refusal through and starts nothing", async () => {
    mocks.createTextSession.mockResolvedValue({ ok: false, error: "limit" });
    expect(await solveTextAction({ text: "1+1" })).toEqual({ ok: false, error: "limit" });
    expect(mocks.scheduleRun).not.toHaveBeenCalled();
  });

  it("validates the photo request before signing anything", async () => {
    expect(
      await startPhotoAction({ kind: "photo", mime: "text/html", size: 10 }),
    ).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(
      await startPhotoAction({ kind: "photo", mime: "image/png", size: 3_000_000 }),
    ).toEqual({ ok: false, error: "invalid" });
    mocks.startPhotoSession.mockResolvedValue({
      ok: true,
      data: { sessionId: SESSION, uploadUrl: "https://u" },
    });
    expect(
      await startPhotoAction({
        kind: "file",
        mime: "image/jpeg",
        size: 10,
        ownerId: OTHER,
      }),
    ).toEqual({ ok: true, sessionId: SESSION, uploadUrl: "https://u" });
    expect(mocks.startPhotoSession).toHaveBeenCalledWith(database, store, {
      kind: "file",
      mime: "image/jpeg",
      size: 10,
      ownerId: USER.userId,
      now: ANY_DATE,
    });
  });

  it.each(sessionActions)(
    "%s acts on a session as the signed-in teacher only",
    async (_, action, service) => {
      expect(await action({ sessionId: "not-a-uuid" })).toEqual({
        ok: false,
        error: "invalid",
      });
      service.mockResolvedValue({ ok: true, data: { jobId: "j" } });
      expect(await action({ sessionId: SESSION, ownerId: OTHER })).toEqual({
        ok: true,
        jobId: "j",
      });
      expect(service.mock.calls[0].at(-1)).toEqual({
        ownerId: USER.userId,
        sessionId: SESSION,
        now: ANY_DATE,
      });
      expect(mocks.scheduleRun).toHaveBeenCalledTimes(1);
      service.mockRejectedValue(new Error("select * from solver_sessions"));
      expect(await action({ sessionId: SESSION })).toEqual({
        ok: false,
        error: "generic",
      });
      // The error name only, never its message (SQL, ids).
      expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain("select");
    },
  );

  it("confirms a reading as the signed-in teacher", async () => {
    mocks.confirmExtraction.mockResolvedValue({ ok: false, error: "markers" });
    expect(
      await confirmExtractionAction({
        sessionId: SESSION,
        text: "[[?]]x[[?]]",
        ownerId: OTHER,
      }),
    ).toEqual({ ok: false, error: "markers" });
    expect(mocks.confirmExtraction).toHaveBeenCalledWith(database, {
      ownerId: USER.userId,
      sessionId: SESSION,
      text: "[[?]]x[[?]]",
      now: ANY_DATE,
    });
  });
});
