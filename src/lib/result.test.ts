import { describe, expect, expectTypeOf, it } from "vitest";
import { err, ok, type Result } from "./result";

describe("Result helpers", () => {
  it("ok() wraps data and ok() with no argument is a void success", () => {
    expect(ok(5)).toEqual({ ok: true, data: 5 });
    expect(ok()).toEqual({ ok: true, data: undefined });
  });

  it("err() wraps the error payload", () => {
    expect(err("not_found")).toEqual({ ok: false, error: "not_found" });
  });

  it("is assignable to the declared union and narrows on ok", () => {
    const success: Result<number, "a"> = ok(1);
    const failure: Result<number, "a"> = err("a");
    const voidResult: Result<void, "a"> = ok();
    expectTypeOf(voidResult).toEqualTypeOf<Result<void, "a">>();
    for (const result of [success, failure]) {
      if (result.ok) expectTypeOf(result.data).toEqualTypeOf<number>();
      else expectTypeOf(result.error).toEqualTypeOf<"a">();
    }
    expect(success.ok).toBe(true);
    expect(failure.ok).toBe(false);
  });

  it("defaults the error type to string", () => {
    // The explicit `string` is the point: it must equal the default.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments
    expectTypeOf<Result<number>>().toEqualTypeOf<Result<number, string>>();
  });
});
