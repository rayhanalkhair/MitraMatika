import { describe, expect, it } from "vitest";
import { safeErrorSummary } from "./error-summary";

describe("safeErrorSummary", () => {
  it("keeps the name and the Postgres code, own or wrapped, and nothing else", () => {
    expect(
      safeErrorSummary(Object.assign(new Error("secret"), { code: "23505" })),
    ).toEqual({
      name: "Error",
      code: "23505",
    });
    expect(
      safeErrorSummary(
        Object.assign(new TypeError("secret"), { cause: { code: "57P01" } }),
      ),
    ).toEqual({ name: "TypeError", code: "57P01" });
    expect(safeErrorSummary("boom")).toEqual({ name: "string", code: null });
  });
});
