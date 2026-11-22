import { describe, expect, it, vi } from "vitest";
import type { AiCallLogger } from "../logging";
import { AiImageError, AiProviderError } from "../types";
import { createGeminiProvider } from "./gemini";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createGeminiProvider", () => {
  it("sends the expected request and returns the concatenated text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: '{"n":' }, { text: "5}" }] } }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 4,
          totalTokenCount: 14,
        },
      }),
    );
    const provider = createGeminiProvider({ apiKey: "AIza_test", fetchImpl });

    const result = await provider.complete("gemini-flash", "sistem", "prompt");

    expect(result.text).toBe('{"n":5}');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash:generateContent",
    );
    expect(url as string).not.toContain("key=");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza_test");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string) as {
      systemInstruction: unknown;
      contents: unknown;
      generationConfig: { responseMimeType: string };
    };
    expect(body.systemInstruction).toEqual({ parts: [{ text: "sistem" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "prompt" }] }]);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("throws a descriptive error on a non-2xx response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(400, { error: { message: "invalid api key" } }));
    const provider = createGeminiProvider({ apiKey: "bad", fetchImpl });
    const error = await provider.complete("m", "s", "p").catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "unavailable", status: 400 });
    expect((error as Error).message).not.toMatch(/invalid api key/);
    expect((error as AiProviderError).detail).toMatch(/invalid api key/);
  });

  it("throws when candidates are missing or empty", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { candidates: [] }));
    const provider = createGeminiProvider({ apiKey: "k", fetchImpl });
    await expect(provider.complete("m", "s", "p")).rejects.toThrow();
  });

  it("records a successful call in the logger with usage and latency", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: "{}" }] } }],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 2,
          totalTokenCount: 3,
        },
      }),
    );
    const record = vi.fn<AiCallLogger["record"]>().mockResolvedValue(undefined);
    const provider = createGeminiProvider({ apiKey: "k", fetchImpl, logger: { record } });
    await provider.complete("m", "s", "p");

    expect(record).toHaveBeenCalledTimes(1);
    const entry = record.mock.calls[0][0];
    expect(entry.provider).toBe("gemini");
    expect(entry.outcome).toBe("ok");
    expect(entry.promptTokens).toBe(1);
    expect(entry.completionTokens).toBe(2);
    expect(entry.totalTokens).toBe(3);
  });

  it("records a failed call in the logger", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(500, { error: { message: "boom" } }));
    const record = vi.fn<AiCallLogger["record"]>().mockResolvedValue(undefined);
    const provider = createGeminiProvider({ apiKey: "k", fetchImpl, logger: { record } });
    await expect(provider.complete("m", "s", "p")).rejects.toThrow();
    expect(record.mock.calls[0][0].outcome).toBe("error");
  });

  it("aborts the request after the configured timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    const record = vi.fn<AiCallLogger["record"]>().mockResolvedValue(undefined);
    const provider = createGeminiProvider({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 10,
      logger: { record },
    });
    await expect(provider.complete("m", "s", "p")).rejects.toThrow();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].outcome).toBe("error");
  });

  it("reports a rejected key (401) as auth_failed and never echoes the key", async () => {
    const FAKE_KEY = ["fake", "key", "for", "tests"].join("-");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(401, { error: { message: "Invalid API Key" } }));
    const record = vi.fn<AiCallLogger["record"]>().mockResolvedValue(undefined);
    const provider = createGeminiProvider({
      apiKey: FAKE_KEY,
      fetchImpl,
      logger: { record },
    });

    const error = await provider.complete("m", "s", "p").catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: "auth_failed", status: 401 });
    expect((error as AiProviderError).detail).toContain("401");
    expect(
      JSON.stringify([
        (error as Error).message,
        (error as AiProviderError).detail,
        record.mock.calls,
      ]),
    ).not.toContain(FAKE_KEY);
  });

  it("records a failed call in the logger when the fetch itself rejects", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network unreachable"));
    const record = vi.fn<AiCallLogger["record"]>().mockResolvedValue(undefined);
    const provider = createGeminiProvider({ apiKey: "k", fetchImpl, logger: { record } });

    await expect(provider.complete("m", "s", "p")).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].outcome).toBe("error");
    expect(record.mock.calls[0][0].errorMessage).toMatch(/network unreachable/);
  });

  it("records a failed call in the logger when the response body is not valid JSON", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not json", { status: 200 }));
    const record = vi.fn<AiCallLogger["record"]>().mockResolvedValue(undefined);
    const provider = createGeminiProvider({ apiKey: "k", fetchImpl, logger: { record } });

    await expect(provider.complete("m", "s", "p")).rejects.toThrow();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].outcome).toBe("error");
  });
});

describe("gemini provider failures", () => {
  const failing = (status: number, headers: Record<string, string> = {}) =>
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "secret provider detail" } }), {
        status,
        headers,
      }),
    );

  it("throws a rate_limited AiProviderError with the parsed retry-after", async () => {
    const provider = createGeminiProvider({
      apiKey: "k",
      fetchImpl: failing(429, { "retry-after": "42" }),
    });
    const error = await provider.complete("m", "s", "p").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({
      kind: "rate_limited",
      status: 429,
      retryAfterMs: 42_000,
    });
    expect((error as Error).message).not.toContain("secret provider detail");
    expect((error as AiProviderError).detail).toContain("secret provider detail");
  });

  it("keeps the API key out of detail and the logger when a rejection echoes the URL", async () => {
    const record = vi.fn<AiCallLogger["record"]>().mockResolvedValue(undefined);
    const provider = createGeminiProvider({
      apiKey: "AIzaSECRET",
      fetchImpl: vi
        .fn()
        .mockRejectedValue(
          new TypeError("Failed to parse URL from https://x/y?key=AIzaSECRET&alt=json"),
        ),
      logger: { record },
    });
    const error = await provider.complete("m", "s", "p").catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "unavailable" });
    expect((error as AiProviderError).detail).not.toContain("AIzaSECRET");
    expect(record.mock.calls[0][0].errorMessage).not.toContain("AIzaSECRET");
  });

  it("bounds a hostile provider message in detail", async () => {
    const provider = createGeminiProvider({
      apiKey: "k",
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "z".repeat(5_000) } }), {
          status: 500,
          headers: { "retry-after": "9".repeat(5_000) },
        }),
      ),
    });
    const error = await provider.complete("m", "s", "p").catch((e: unknown) => e);
    expect((error as AiProviderError).detail!.length).toBeLessThanOrEqual(500);
  });

  it("classifies a 500 as unavailable", async () => {
    const provider = createGeminiProvider({ apiKey: "k", fetchImpl: failing(500) });
    await expect(provider.complete("m", "s", "p")).rejects.toMatchObject({
      kind: "unavailable",
      status: 500,
    });
  });

  it("classifies an abort as a timeout", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const provider = createGeminiProvider({
      apiKey: "k",
      fetchImpl: vi.fn().mockRejectedValue(abort),
    });
    await expect(provider.complete("m", "s", "p")).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("classifies a 200 without content as invalid_response", async () => {
    const provider = createGeminiProvider({
      apiKey: "k",
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
        ),
    });
    await expect(provider.complete("m", "s", "p")).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });
});

describe("createGeminiProvider image input", () => {
  it("refuses images with a typed error instead of dropping them", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = createGeminiProvider({ apiKey: "k", fetchImpl });

    const error = await provider
      .complete("m", "s", "p", {
        images: [{ mime: "image/png", base64: "iVBORw0KGgo=" }],
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiImageError);
    expect(error).toMatchObject({ code: "images_unsupported" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
