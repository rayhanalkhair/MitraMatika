import { describe, expect, it } from "vitest";
import { oneAtATime } from "./render-queue";

describe("oneAtATime", () => {
  it("runs one render at a time and keeps going after a failure", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = oneAtATime(
      () =>
        new Promise<string>((resolve) => {
          order.push("first start");
          release = () => {
            order.push("first end");
            resolve("a");
          };
        }),
    );
    const failing = oneAtATime(() => {
      order.push("second start");
      return Promise.reject(new Error("boom"));
    });
    const third = oneAtATime(() => {
      order.push("third start");
      return Promise.resolve("c");
    });
    await Promise.resolve();
    expect(order).toEqual(["first start"]);
    release();
    expect(await first).toBe("a");
    await expect(failing).rejects.toThrow("boom");
    expect(await third).toBe("c");
    expect(order).toEqual(["first start", "first end", "second start", "third start"]);
  });
});
