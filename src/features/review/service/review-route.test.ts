import { describe, expect, it, vi } from "vitest";
import { handleReviewRequest } from "./review-route";
import { logger } from "@/lib/logger";

const review = { requested: 1, curriculum: null, questions: [] };
const ok = {
  ok: true as const,
  data: {
    status: "allowed" as const,
    userId: "11111111-1111-4111-8111-111111111111",
    email: "guru@example.test",
    displayName: null,
  },
};
const ID = "55555555-5555-4555-8555-555555555555";

describe("handleReviewRequest", () => {
  it("answers 401 without reading", async () => {
    const readReview = vi.fn();
    const r401 = await handleReviewRequest(ID, {
      authorize: () => Promise.resolve({ ok: false, error: "unauthenticated" }),
      readReview,
    });
    expect(r401.status).toBe(401);
    expect(readReview).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed id and for a missing or foreign request", async () => {
    const readReview = vi.fn(() => Promise.resolve(null));
    expect(
      (
        await handleReviewRequest("not-a-uuid", {
          authorize: () => Promise.resolve(ok),
          readReview,
        })
      ).status,
    ).toBe(404);
    expect(readReview).not.toHaveBeenCalled();
    expect(
      (
        await handleReviewRequest(ID, {
          authorize: () => Promise.resolve(ok),
          readReview,
        })
      ).status,
    ).toBe(404);
  });

  it("returns the review with no-store caching", async () => {
    const response = await handleReviewRequest(ID, {
      authorize: () => Promise.resolve(ok),
      readReview: () => Promise.resolve(review),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(review);
  });

  it("answers 500 without leaking the error when the read throws", async () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const response = await handleReviewRequest(ID, {
      authorize: () => Promise.resolve(ok),
      readReview: () => {
        return Promise.reject(new Error("secret db detail"));
      },
    });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    spy.mockRestore();
  });
});
