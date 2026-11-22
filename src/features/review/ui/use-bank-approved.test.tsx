// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("@/features/generation/actions/create-request", () => ({
  bankApprovedAction: mocks.action,
}));

import { useBankApproved } from "./use-bank-approved";

const reviewWith = (banked: boolean) => ({
  kind: "ok",
  review: {
    requested: 2,
    curriculum: null,
    questions: [
      { questionId: "a", decision: "approved", banked },
      { questionId: "b", decision: "draft", banked: false },
    ],
  },
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["request-review", "r1"], reviewWith(false));
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, invalidate, ...renderHook(() => useBankApproved("r1"), { wrapper }) };
}

// A block body: returning the mock from beforeEach would make vitest call it as a cleanup hook.
beforeEach(() => {
  mocks.action.mockReset();
});
afterEach(cleanup);

describe("useBankApproved", () => {
  it("calls the action with the request id, returns the result and invalidates the review", async () => {
    mocks.action.mockResolvedValue({ ok: true, saved: 2 });
    const { result, invalidate } = setup();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.save();
    });
    expect(outcome).toEqual({ ok: true, saved: 2 });
    expect(mocks.action).toHaveBeenCalledWith({ requestId: "r1" });
    expect(result.current.pending).toBe(false);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["request-review", "r1"] });
  });

  it("moves the cached review to the saved state at once, without waiting for a refetch", async () => {
    mocks.action.mockResolvedValue({ ok: true, saved: 1 });
    const { result, client, invalidate } = setup();
    // The refetch never settles: the saved state must not depend on it.
    invalidate.mockReturnValue(new Promise(() => undefined));
    act(() => {
      void result.current.save();
    });
    await waitFor(() => {
      expect(
        client
          .getQueryData<ReturnType<typeof reviewWith>>(["request-review", "r1"])!
          .review.questions.map((q) => q.banked),
      ).toEqual([true, false]);
    });
  });

  it("leaves the cached review alone when the save fails", async () => {
    mocks.action.mockResolvedValue({ ok: false, reason: "generic" });
    const { result, client } = setup();
    await act(async () => {
      await result.current.save();
    });
    expect(client.getQueryData(["request-review", "r1"])).toEqual(reviewWith(false));
  });

  it("passes an ok:false result through and still invalidates", async () => {
    mocks.action.mockResolvedValue({ ok: false, reason: "invalid" });
    const { result, invalidate } = setup();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.save();
    });
    expect(outcome).toEqual({ ok: false, reason: "invalid" });
    expect(invalidate).toHaveBeenCalled();
  });

  it("turns a thrown action into a generic failure", async () => {
    mocks.action.mockRejectedValue(new Error("network"));
    const { result, invalidate } = setup();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.save();
    });
    expect(outcome).toEqual({ ok: false, reason: "generic" });
    expect(invalidate).toHaveBeenCalled();
  });

  it("reports pending while the save is in flight", async () => {
    let release!: (value: unknown) => void;
    mocks.action.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const { result } = setup();
    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.save();
    });
    await waitFor(() => {
      expect(result.current.pending).toBe(true);
    });
    await act(async () => {
      release({ ok: true, saved: 0 });
      await promise;
    });
    await waitFor(() => {
      expect(result.current.pending).toBe(false);
    });
  });
});
