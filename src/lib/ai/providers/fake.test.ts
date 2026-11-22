import { describe, expect, it } from "vitest";
import { AiProviderError } from "../types";
import { createFakeProvider } from "./fake";

describe("createFakeProvider scripted errors", () => {
  it("throws an Error response in order and plays the rest", async () => {
    const provider = createFakeProvider("groq", [
      new AiProviderError("rate_limited", "dibatasi", {
        status: 429,
        retryAfterMs: 5_000,
      }),
      '{"ok":true}',
    ]);
    await expect(provider.complete("m", "s", "p")).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 5_000,
    });
    const next = await provider.complete("m", "s", "p");
    expect(next.text).toBe('{"ok":true}');
    expect(provider.calls).toHaveLength(2);
  });
});
