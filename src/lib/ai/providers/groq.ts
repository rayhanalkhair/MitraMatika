import "server-only";
import {
  AiProviderError,
  type AiCompleteOptions,
  type AiCompletion,
  type AiProvider,
} from "../types";
import { checkImages } from "../images";
import {
  classifyHttpFailure,
  makeDetail,
  providerFailureMessage,
  toProviderError,
} from "../provider-errors";
import { NullAiCallLog, type AiCallLogger } from "../logging";

export interface GroqProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: AiCallLogger;
  temperature?: number;
}

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_TEMPERATURE = 0.2;

interface GroqSuccessBody {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface GroqErrorBody {
  error?: { message?: string };
}

// OpenAI-compatible user message: a plain string, or a content array with each image as a data URL.
function userContent(prompt: string, options: AiCompleteOptions | undefined) {
  const images = options?.images ?? [];
  if (images.length === 0) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mime};base64,${image.base64}` },
    })),
  ];
}

export function createGroqProvider(options: GroqProviderOptions): AiProvider {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const logger = options.logger ?? new NullAiCallLog();
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "groq",
    async complete(
      model: string,
      system: string,
      prompt: string,
      callOptions?: AiCompleteOptions,
    ): Promise<AiCompletion> {
      // The base64 goes into a data URL: check it here too, not only in the gateway.
      checkImages(callOptions?.images ?? []);
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        let content: string;
        let usage: GroqSuccessBody["usage"];

        try {
          const response = await doFetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: system },
                { role: "user", content: userContent(prompt, callOptions) },
              ],
              temperature,
              response_format: { type: "json_object" },
              ...(callOptions?.maxOutputTokens !== undefined
                ? { max_tokens: callOptions.maxOutputTokens }
                : {}),
            }),
            signal: controller.signal,
          });

          const bodyText = await response.text();

          if (!response.ok) {
            let detail = `Groq API mengembalikan status ${String(response.status)}`;
            try {
              const parsed = JSON.parse(bodyText) as GroqErrorBody;
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

          const data = JSON.parse(bodyText) as GroqSuccessBody;
          const parsedContent = data.choices?.[0]?.message?.content;
          if (typeof parsedContent !== "string") {
            throw new AiProviderError(
              "invalid_response",
              providerFailureMessage("invalid_response"),
              {
                detail: makeDetail(
                  "Respons Groq tidak memiliki choices[0].message.content berupa teks.",
                ),
              },
            );
          }

          content = parsedContent;
          usage = data.usage;
        } catch (error) {
          const latencyMs = Date.now() - start;
          const failure = toProviderError(error);
          await logger.record({
            at: new Date().toISOString(),
            provider: "groq",
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
          provider: "groq",
          model,
          latencyMs,
          outcome: "ok",
          promptTokens: usage?.prompt_tokens,
          completionTokens: usage?.completion_tokens,
          totalTokens: usage?.total_tokens,
        });

        return {
          text: content,
          usage: usage
            ? {
                inputTokens: usage.prompt_tokens ?? 0,
                outputTokens: usage.completion_tokens ?? 0,
              }
            : undefined,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
