import "server-only";
import {
  AiImageError,
  AiProviderError,
  type AiCompleteOptions,
  type AiCompletion,
  type AiProvider,
} from "../types";
import {
  classifyHttpFailure,
  makeDetail,
  providerFailureMessage,
  toProviderError,
} from "../provider-errors";
import { NullAiCallLog, type AiCallLogger } from "../logging";

export interface GeminiProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: AiCallLogger;
  temperature?: number;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_TEMPERATURE = 0.2;

interface GeminiSuccessBody {
  candidates?: { content?: { parts?: { text?: unknown }[] } }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface GeminiErrorBody {
  error?: { message?: string };
}

export function createGeminiProvider(options: GeminiProviderOptions): AiProvider {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const logger = options.logger ?? new NullAiCallLog();
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "gemini",
    async complete(
      model: string,
      system: string,
      prompt: string,
      callOptions?: AiCompleteOptions,
    ): Promise<AiCompletion> {
      // Gemini only ever receives C0 text here; images (C2 material) are refused, never dropped.
      if (callOptions?.images && callOptions.images.length > 0) {
        throw new AiImageError(
          "images_unsupported",
          "Penyedia AI ini tidak menerima gambar.",
        );
      }
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        let content: string;
        let usage: GeminiSuccessBody["usageMetadata"];

        try {
          // The key goes in a header, never in the URL, so a runtime error message cannot echo it.
          const url = `${baseUrl}/models/${model}:generateContent`;
          const response = await doFetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": options.apiKey,
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: {
                temperature,
                responseMimeType: "application/json",
                ...(callOptions?.maxOutputTokens !== undefined
                  ? { maxOutputTokens: callOptions.maxOutputTokens }
                  : {}),
              },
            }),
            signal: controller.signal,
          });

          const bodyText = await response.text();

          if (!response.ok) {
            let detail = `Gemini API mengembalikan status ${String(response.status)}`;
            try {
              const parsed = JSON.parse(bodyText) as GeminiErrorBody;
              if (parsed.error?.message) {
                detail += `: ${parsed.error.message}`;
              }
            } catch {
              // Body was not JSON; keep the generic detail.
            }
            const retryAfter = response.headers.get("retry-after");
            if (retryAfter) {
              detail += ` (retry-after: ${retryAfter} detik)`;
            }
            const failure = classifyHttpFailure(response.status, retryAfter);
            throw new AiProviderError(
              failure.kind,
              providerFailureMessage(failure.kind),
              {
                status: response.status,
                retryAfterMs: failure.retryAfterMs,
                detail: makeDetail(detail),
              },
            );
          }

          const data = JSON.parse(bodyText) as GeminiSuccessBody;
          const parts = data.candidates?.[0]?.content?.parts ?? [];
          const parsedContent = parts
            .map((p) => (typeof p.text === "string" ? p.text : ""))
            .join("");
          if (!parsedContent) {
            throw new AiProviderError(
              "invalid_response",
              providerFailureMessage("invalid_response"),
              {
                detail: makeDetail(
                  "Respons Gemini tidak memiliki candidates[0].content.parts berupa teks.",
                ),
              },
            );
          }

          content = parsedContent;
          usage = data.usageMetadata;
        } catch (error) {
          const latencyMs = Date.now() - start;
          const failure = toProviderError(error);
          await logger.record({
            at: new Date().toISOString(),
            provider: "gemini",
            model,
            latencyMs,
            outcome: "error",
            errorMessage: failure.detail ?? failure.message,
          });
          throw failure;
        }

        const latencyMs = Date.now() - start;
        await logger.record({
          at: new Date().toISOString(),
          provider: "gemini",
          model,
          latencyMs,
          outcome: "ok",
          promptTokens: usage?.promptTokenCount,
          completionTokens: usage?.candidatesTokenCount,
          totalTokens: usage?.totalTokenCount,
        });

        return {
          text: content,
          usage: usage
            ? {
                inputTokens: usage.promptTokenCount ?? 0,
                outputTokens: usage.candidatesTokenCount ?? 0,
              }
            : undefined,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
