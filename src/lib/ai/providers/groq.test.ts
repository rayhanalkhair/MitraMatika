import { describe, expect, it, vi } from "vitest";
import type { AiCallLogger } from "../logging";
import { AiImageError, AiProviderError } from "../types";
import { createGroqProvider } from "./groq";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("createGroqProvider", () => {
  it("sends the expected request and returns the message content", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ message: { content: '{"n":5}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
    );
    const provider = createGroqProvider({ apiKey: "gsk_test", fetchImpl });

    const result = await provider.complete("openai/gpt-oss-120b", "sistem", "prompt");

    expect(result.text).toBe('{"n":5}');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    const headers = init?.headers as Record<string, string>;
    expect(init?.method).toBe("POST");
    expect(headers.Authorization).toBe("Bearer gsk_test");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init?.body as string) as {
      model: string;
      messages: unknown;
      response_format: unknown;
    };
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.messages).toEqual([
      { role: "system", content: "sistem" },
      { role: "user", content: "prompt" },
    ]);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("returns no usage when the provider reports none", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { choices: [{ message: { content: "{}" } }] }),
      );
    const provider = createGroqProvider({ apiKey: "k", fetchImpl });
    const result = await provider.complete("m", "s", "p");
    expect(result).toEqual({ text: "{}", usage: undefined });
  });

  it("uses a custom baseUrl when provided", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { choices: [{ message: { content: "{}" } }] }),
      );
    const provider = createGroqProvider({
      apiKey: "k",
      baseUrl: "https://example.test/v1",
      fetchImpl,
    });
    await provider.complete("m", "s", "p");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://example.test/v1/chat/completions");
  });

  it("throws a descriptive error on a non-2xx response, including retry-after", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse(
            429,
            { error: { message: "rate limited" } },
            { "retry-after": "12" },
          ),
        ),
      );
    const provider = createGroqProvider({ apiKey: "k", fetchImpl });

    await expect(provider.complete("m", "s", "p")).rejects.toMatchObject({
      kind: "rate_limited",
      status: 429,
      retryAfterMs: 12_000,
    });
    const error = await provider.complete("m", "s", "p").catch((e: unknown) => e);
    expect((error as Error).message).not.toMatch(/rate limited/);
    expect((error as AiProviderError).detail).toMatch(/rate limited/);
    expect((error as AiProviderError).detail).toMatch(/12/);
  });

  it("throws when the response body is not the expected shape", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { choices: [] }));
    const provider = createGroqProvider({ apiKey: "k", fetchImpl });
    await expect(provider.complete("m", "s", "p")).rejects.toThrow();
  });

  it("records a successful call in the logger with usage and latency", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    );
    const record = vi.fn<AiCallLogger["record"]>().mockResolvedValue(undefined);
    const provider = createGroqProvider({ apiKey: "k", fetchImpl, logger: { record } });
    await provider.complete("m", "s", "p");

    expect(record).toHaveBeenCalledTimes(1);
    const entry = record.mock.calls[0][0];
    expect(entry.provider).toBe("groq");
    expect(entry.model).toBe("m");
    expect(entry.outcome).toBe("ok");
    expect(entry.promptTokens).toBe(1);
    expect(entry.completionTokens).toBe(2);
    expect(entry.totalTokens).toBe(3);
    expect(typeof entry.latencyMs).toBe("number");
  });

  it("records a failed call in the logger", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(500, { error: { message: "boom" } }));
    const record = vi.fn<AiCallLogger["record"]>().mockResolvedValue(undefined);
    const provider = createGroqProvider({ apiKey: "k", fetchImpl, logger: { record } });

    await expect(provider.complete("m", "s", "p")).rejects.toThrow();
    expect(record).toHaveBeenCalledTimes(1);
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
    const provider = createGroqProvider({
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
    const provider = createGroqProvider({
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
    const provider = createGroqProvider({ apiKey: "k", fetchImpl, logger: { record } });

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
    const provider = createGroqProvider({ apiKey: "k", fetchImpl, logger: { record } });

    await expect(provider.complete("m", "s", "p")).rejects.toThrow();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].outcome).toBe("error");
  });
});

describe("groq provider failures", () => {
  const failing = (status: number, headers: Record<string, string> = {}) =>
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "secret provider detail" } }), {
        status,
        headers,
      }),
    );

  it("throws a rate_limited AiProviderError with the parsed retry-after", async () => {
    const provider = createGroqProvider({
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

  it("classifies a 503 as unavailable", async () => {
    const provider = createGroqProvider({ apiKey: "k", fetchImpl: failing(503) });
    await expect(provider.complete("m", "s", "p")).rejects.toMatchObject({
      kind: "unavailable",
      status: 503,
    });
  });

  it("classifies an abort as a timeout", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const provider = createGroqProvider({
      apiKey: "k",
      fetchImpl: vi.fn().mockRejectedValue(abort),
    });
    await expect(provider.complete("m", "s", "p")).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("classifies a network failure as unavailable", async () => {
    const provider = createGroqProvider({
      apiKey: "k",
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    });
    await expect(provider.complete("m", "s", "p")).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("classifies a 200 without content as invalid_response", async () => {
    const provider = createGroqProvider({
      apiKey: "k",
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ choices: [] }), { status: 200 }),
        ),
    });
    await expect(provider.complete("m", "s", "p")).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });
});

describe("createGroqProvider image input", () => {
  function okFetch() {
    return vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { choices: [{ message: { content: "{}" } }] }),
      );
  }

  function sentBody(fetchImpl: ReturnType<typeof okFetch>) {
    return JSON.parse(fetchImpl.mock.calls[0][1]?.body as string) as {
      messages: unknown;
      max_tokens?: number;
    };
  }

  it("sends the prompt and each image as a content array of image_url data URLs", async () => {
    const fetchImpl = okFetch();
    const provider = createGroqProvider({ apiKey: "k", fetchImpl });

    await provider.complete("qwen/qwen3.8-27b", "sistem", "Transkripsikan.", {
      images: [
        { mime: "image/png", base64: "iVBORw0KGgo=" },
        { mime: "image/jpeg", base64: "/9j/4AAQ" },
      ],
    });

    expect(sentBody(fetchImpl).messages).toEqual([
      { role: "system", content: "sistem" },
      {
        role: "user",
        content: [
          { type: "text", text: "Transkripsikan." },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
        ],
      },
    ]);
  });

  it("caps the output with max_tokens only when asked", async () => {
    const capped = okFetch();
    await createGroqProvider({ apiKey: "k", fetchImpl: capped }).complete("m", "s", "p", {
      maxOutputTokens: 900,
    });
    expect(sentBody(capped).max_tokens).toBe(900);

    const uncapped = okFetch();
    await createGroqProvider({ apiKey: "k", fetchImpl: uncapped }).complete(
      "m",
      "s",
      "p",
    );
    expect(sentBody(uncapped)).not.toHaveProperty("max_tokens");
  });

  it("keeps a plain string user message when no images are given", async () => {
    const fetchImpl = okFetch();
    await createGroqProvider({ apiKey: "k", fetchImpl }).complete("m", "s", "p", {
      images: [],
    });
    expect(sentBody(fetchImpl).messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "p" },
    ]);
  });

  it("refuses an image that is not valid base64 of its type, before any request", async () => {
    const fetchImpl = okFetch();
    const provider = createGroqProvider({ apiKey: "k", fetchImpl });
    const error = await provider
      .complete("m", "s", "p", {
        images: [{ mime: "image/png", base64: 'x" onerror="' }],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiImageError);
    expect(error).toMatchObject({ code: "image_invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
