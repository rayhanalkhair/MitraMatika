import { describe, expect, it } from "vitest";
import { failureToErrorEntry } from "./failure-record";
import type { FailureInfo } from "./runner";

const info = (type: string, attempts = 2): FailureInfo =>
  ({
    job: {
      id: "33333333-3333-4333-8333-333333333333",
      ownerId: "11111111-1111-4111-8111-111111111111",
      correlationId: "22222222-2222-4222-8222-222222222222",
      type,
      attempts,
    },
    failure: { code: "provider_error", message: "The provider returned 500." },
  }) as unknown as FailureInfo;

describe("failureToErrorEntry", () => {
  it("uses job:<type> as the source for a normal job type", () => {
    expect(failureToErrorEntry(info("generate_batch"))).toEqual({
      ownerId: "11111111-1111-4111-8111-111111111111",
      correlationId: "22222222-2222-4222-8222-222222222222",
      source: "job:generate_batch",
      code: "provider_error",
      message: "The provider returned 500.",
      context: {
        jobId: "33333333-3333-4333-8333-333333333333",
        attempts: 3,
        type: "generate_batch",
      },
    });
  });

  it("falls back to the job source and keeps the type for an oddly named type", () => {
    const entry = failureToErrorEntry(info("Bad Type!"));
    expect(entry.source).toBe("job");
    expect(entry.context).toMatchObject({ type: "Bad Type!" });
  });

  it("counts the failing attempt on top of the stored attempts", () => {
    expect(failureToErrorEntry(info("generate_batch", 0)).context).toMatchObject({
      attempts: 1,
    });
  });
});
