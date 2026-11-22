import { describe, expect, it, vi } from "vitest";
import {
  fetchRequestReview,
  patchReviewBanked,
  patchReviewDecision,
  reviewPollInterval,
  reviewRefetchInterval,
  type ReviewResult,
} from "./review-client";

const review = { requested: 1, curriculum: null, questions: [] };
const json = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe("reviewPollInterval", () => {
  it("polls every 3 s while the job is queued or running, 15 s while deferred, and stops after", () => {
    for (const s of ["queued", "running"] as const)
      expect(reviewPollInterval(s)).toBe(3000);
    expect(reviewPollInterval("deferred")).toBe(15_000);
    expect(reviewPollInterval("stopped")).toBe(false);
    expect(reviewPollInterval("unreachable")).toBe(15_000);
    for (const s of ["succeeded", "failed", "cancelled"] as const)
      expect(reviewPollInterval(s)).toBe(false);
    expect(reviewPollInterval(undefined)).toBe(3000);
  });
});

describe("fetchRequestReview", () => {
  it("parses a review", async () => {
    expect(await fetchRequestReview("r", json(200, review))).toEqual({
      kind: "ok",
      review,
    });
  });
  it("maps 401/403 to signed-out and 404 to not-found", async () => {
    expect(await fetchRequestReview("r", json(401, {}))).toEqual({ kind: "signed-out" });
    expect(await fetchRequestReview("r", json(403, {}))).toEqual({ kind: "signed-out" });
    expect(await fetchRequestReview("r", json(404, {}))).toEqual({ kind: "not-found" });
  });
  it("throws on a server error and on a body of the wrong shape", async () => {
    await expect(fetchRequestReview("r", json(500, {}))).rejects.toThrow();
    await expect(fetchRequestReview("r", json(200, { nope: true }))).rejects.toThrow();
  });
});

describe("reviewRefetchInterval", () => {
  const ok: ReviewResult = {
    kind: "ok",
    review: { requested: 1, curriculum: null, questions: [] },
  };
  it("retries every 15 s after a failed fetch, so a failed final fetch cannot stay stale", () => {
    expect(reviewRefetchInterval({ status: "error" }, "running")).toBe(15_000);
    expect(reviewRefetchInterval({ status: "error" }, "succeeded")).toBe(15_000);
  });
  it("follows the job after a successful fetch", () => {
    expect(reviewRefetchInterval({ status: "success", data: ok }, "running")).toBe(3000);
    expect(reviewRefetchInterval({ status: "success", data: ok }, "deferred")).toBe(
      15_000,
    );
    expect(reviewRefetchInterval({ status: "success", data: ok }, "succeeded")).toBe(
      false,
    );
    expect(reviewRefetchInterval({ status: "pending" }, undefined)).toBe(3000);
    expect(reviewRefetchInterval({ status: "success", data: ok }, "unreachable")).toBe(
      15_000,
    );
  });
  it("stops for signed-out and not-found answers and for a stopped job", () => {
    expect(
      reviewRefetchInterval(
        { status: "success", data: { kind: "signed-out" } },
        "running",
      ),
    ).toBe(false);
    expect(
      reviewRefetchInterval(
        { status: "success", data: { kind: "not-found" } },
        "running",
      ),
    ).toBe(false);
    expect(reviewRefetchInterval({ status: "success", data: ok }, "stopped")).toBe(false);
    expect(reviewRefetchInterval({ status: "error" }, "stopped")).toBe(false);
  });
});

describe("patchReviewBanked", () => {
  const q = (id: string, decision: string, banked: boolean) =>
    ({ questionId: id, decision, banked }) as never;
  const base = {
    requested: 3,
    curriculum: null,
    questions: [
      q("a", "approved", false),
      q("b", "draft", false),
      q("c", "approved", true),
    ],
  };

  it("marks the approved, not yet banked questions as banked and leaves the rest alone", () => {
    const next = patchReviewBanked(base);
    expect(next.questions.map((x) => x.banked)).toEqual([true, false, true]);
    expect(next.questions[1]).toBe(base.questions[1]);
    expect(base.questions[0]).toMatchObject({ banked: false });
  });
});

describe("patchReviewDecision", () => {
  const q = (id: string) =>
    ({ questionId: id, rowVersion: 3, decision: "draft", override: false }) as never;
  const base = { requested: 2, curriculum: null, questions: [q("a"), q("b")] };

  it("changes only the targeted question and bumps its rowVersion", () => {
    const next = patchReviewDecision(base, "a", "approved", true);
    expect(next.questions[0]).toMatchObject({
      decision: "approved",
      override: true,
      rowVersion: 4,
    });
    expect(next.questions[1]).toBe(base.questions[1]);
    expect(base.questions[0]).toMatchObject({ decision: "draft", rowVersion: 3 });
  });

  it("leaves the review unchanged for an unknown id", () => {
    expect(patchReviewDecision(base, "zzz", "rejected", false)).toEqual(base);
  });
});
