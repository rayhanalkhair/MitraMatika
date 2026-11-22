// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewQuestion } from "@/features/review/service/review";
import type { ReviewResult } from "./review-client";
import { IntlWrapper } from "@/test/intl";

const mocks = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("@/features/generation/actions/create-request", () => ({
  decideQuestionAction: mocks.action,
}));

import { useQuestionDecision } from "./use-question-decision";

const question = {
  questionId: "q1",
  versionId: "v1",
  versionNo: 1,
  rowVersion: 2,
  decision: "draft",
  override: false,
} as unknown as ReviewQuestion;
const question2 = {
  ...question,
  questionId: "q2",
  versionId: "v2",
};
const initial: ReviewResult = {
  kind: "ok",
  review: { requested: 2, curriculum: null, questions: [question, question2] },
};
const KEY = ["request-review", "r1"];

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(KEY, initial);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <IntlWrapper>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </IntlWrapper>
  );
  const view = renderHook(() => useQuestionDecision("r1"), { wrapper });
  const cachedById = (id: string) => {
    const data = client.getQueryData<ReviewResult>(KEY);
    return data?.kind === "ok"
      ? data.review.questions.find((item) => item.questionId === id)
      : undefined;
  };
  const cached = () => cachedById("q1");
  return { client, invalidate, cached, cachedById, ...view };
}

beforeEach(() => {
  mocks.action.mockReset();
});
afterEach(cleanup);

describe("useQuestionDecision", () => {
  it("keeps the optimistic state and takes the server rowVersion on success", async () => {
    mocks.action.mockResolvedValue({
      ok: true,
      decision: "approved",
      rowVersion: 7,
      override: false,
      versionNo: 1,
    });
    const { result, cached, invalidate } = setup();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.decide(question, "approve");
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(mocks.action).toHaveBeenCalledWith({
      questionId: "q1",
      versionId: "v1",
      rowVersion: 2,
      action: "approve",
    });
    expect(cached()).toMatchObject({ decision: "approved", rowVersion: 7 });
    expect(result.current.errorFor("q1")).toBeNull();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  it("shows the optimistic state while the action is pending", async () => {
    let resolve!: (value: unknown) => void;
    mocks.action.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result, cached } = setup();
    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.decide(question, "reject");
    });
    await waitFor(() => {
      expect(cached()).toMatchObject({ decision: "rejected", rowVersion: 3 });
    });
    expect(result.current.isPending("q1")).toBe(true);
    expect(result.current.isPending("q2")).toBe(false);
    expect([...result.current.pendingQuestionIds]).toEqual(["q1"]);
    await act(async () => {
      resolve({
        ok: true,
        decision: "rejected",
        rowVersion: 3,
        override: false,
        versionNo: 1,
      });
      await promise;
    });
    await waitFor(() => {
      expect(result.current.pendingQuestionIds.size).toBe(0);
    });
  });

  it("restores the previous review and exposes the error on ok: false", async () => {
    mocks.action.mockResolvedValue({ ok: false, reason: "conflict" });
    const { result, cached, invalidate } = setup();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.decide(question, "approve");
    });
    expect(outcome).toEqual({ ok: false, reason: "conflict" });
    expect(cached()).toMatchObject({ decision: "draft", rowVersion: 2 });
    expect(result.current.errorFor("q1")).toContain("sudah berubah");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  it("restores and exposes generic when the action throws", async () => {
    mocks.action.mockImplementation(() => {
      throw new Error("network");
    });
    const { result, cached, invalidate } = setup();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.decide(question, "reject");
    });
    expect(outcome).toEqual({ ok: false, reason: "generic" });
    expect(cached()).toMatchObject({ decision: "draft", rowVersion: 2 });
    expect(result.current.errorFor("q1")).toBe("Keputusan belum tersimpan. Coba lagi.");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  it("rolls back only the failing question when two decisions overlap", async () => {
    const pending: Record<string, (value: unknown) => void> = {};
    mocks.action.mockImplementation(
      ({ questionId }: { questionId: string }) =>
        new Promise((r) => (pending[questionId] = r)),
    );
    const { result, cachedById } = setup();
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.decide(question, "reject");
      second = result.current.decide(question2, "approve");
    });
    await waitFor(() => {
      expect(cachedById("q1")).toMatchObject({ decision: "rejected" });
      expect(cachedById("q2")).toMatchObject({ decision: "approved" });
    });
    expect([...result.current.pendingQuestionIds].sort()).toEqual(["q1", "q2"]);

    await act(async () => {
      pending.q2({
        ok: true,
        decision: "approved",
        rowVersion: 9,
        override: false,
        versionNo: 1,
      });
      await second;
    });
    expect(result.current.isPending("q1")).toBe(true);
    expect(result.current.isPending("q2")).toBe(false);
    await act(async () => {
      pending.q1({ ok: false, reason: "conflict" });
      await first;
    });
    // Only q1 rolled back; q2 keeps its decision and the server row version.
    expect(cachedById("q1")).toMatchObject({ decision: "draft", rowVersion: 2 });
    expect(cachedById("q2")).toMatchObject({ decision: "approved", rowVersion: 9 });
    expect(result.current.errorFor("q1")).toContain("sudah berubah");
    expect(result.current.errorFor("q2")).toBeNull();
  });

  it("keeps a still-pending optimistic state when the other question fails", async () => {
    const pending: Record<string, (value: unknown) => void> = {};
    mocks.action.mockImplementation(
      ({ questionId }: { questionId: string }) =>
        new Promise((r) => (pending[questionId] = r)),
    );
    const { result, cachedById } = setup();
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.decide(question, "reject");
      second = result.current.decide(question2, "approve");
    });
    await waitFor(() => {
      expect(cachedById("q2")).toMatchObject({ decision: "approved" });
    });
    await act(async () => {
      pending.q1({ ok: false, reason: "generic" });
      await first;
    });
    expect(cachedById("q1")).toMatchObject({ decision: "draft", rowVersion: 2 });
    expect(cachedById("q2")).toMatchObject({ decision: "approved", rowVersion: 3 });
    await act(async () => {
      pending.q2({ ok: false, reason: "conflict" });
      await second;
    });
    expect(cachedById("q2")).toMatchObject({ decision: "draft", rowVersion: 2 });
  });

  it("passes a signed-out or not-found cache through untouched", async () => {
    for (const shape of [{ kind: "signed-out" }, { kind: "not-found" }] as const) {
      for (const response of [
        { ok: true, decision: "approved", rowVersion: 7, override: false, versionNo: 1 },
        { ok: false, reason: "conflict" },
      ]) {
        mocks.action.mockResolvedValue(response);
        const { result, client, unmount } = setup();
        client.setQueryData(KEY, shape);
        await act(async () => {
          await result.current.decide(question, "approve");
        });
        expect(client.getQueryData(KEY)).toEqual(shape);
        unmount();
      }
    }
  });

  it("restores only decision, override and rowVersion, keeping a newer versionId from a poll", async () => {
    let resolve!: (value: unknown) => void;
    mocks.action.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result, client, cached } = setup();
    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.decide(question, "reject");
    });
    await waitFor(() => {
      expect(cached()).toMatchObject({ decision: "rejected" });
    });
    // A poll lands mid-flight with a regenerated version of the same question.
    const data = client.getQueryData<ReviewResult>(KEY);
    if (data?.kind !== "ok") throw new Error("unexpected cache shape");
    client.setQueryData(KEY, {
      kind: "ok",
      review: {
        ...data.review,
        questions: data.review.questions.map((item) =>
          item.questionId === "q1" ? { ...item, versionId: "v-new", versionNo: 2 } : item,
        ),
      },
    });
    await act(async () => {
      resolve({ ok: false, reason: "conflict" });
      await promise;
    });
    expect(cached()).toMatchObject({
      decision: "draft",
      override: false,
      rowVersion: 2,
      versionId: "v-new",
      versionNo: 2,
    });
  });
});
