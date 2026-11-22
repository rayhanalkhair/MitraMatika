import {
  AiOutputError,
  AiPolicyError,
  AiProviderError,
  AiQuotaError,
  type createGateway,
} from "@/lib/ai";

export type Gateway = ReturnType<typeof createGateway>;

// A model call can take up to about a minute (two 30 s provider timeouts) and the function is
// killed at 300 s, so a step must not start with less than this left of the runner's budget.
export const MIN_REMAINING_MS = 90_000;
// Output tokens reserved per question when the gateway estimates the cost of a call.
export const OUTPUT_TOKENS_PER_QUESTION = 700;
// When the per-minute (not the daily) budget refuses a call, try again after this long.
export const QUOTA_RETRY_MS = 60_000;

// Postgres error code, found on the error itself or anywhere along its cause chain (Drizzle wraps).
export function pgCodeOf(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Object; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "";
}

// How long a step may wait for a model lock: whatever is left of the runner budget after the call
// itself needs its minimum, and never less than a second. An integer, never user input.
export function lockWaitMs(deadlineMs: number, nowMs: number): number {
  return Math.max(1_000, Math.floor(deadlineMs - nowMs - MIN_REMAINING_MS));
}

// A provider 429 defers the job (without using an attempt) at most this many times; the next one
// fails the attempt so a revoked or permanently throttled key cannot loop forever.
export const MAX_PROVIDER_DEFERRALS = 5;
export const PROVIDER_RETRY_FLOOR_MS = 60_000;
export const PROVIDER_RETRY_CEIL_MS = 3_600_000;

// How long to wait after a provider 429: the provider's own retry-after (already clamped when it
// was parsed), at least a minute, at most an hour.
export function providerRetryDelayMs(retryAfterMs: number | undefined): number {
  const wait = retryAfterMs ?? PROVIDER_RETRY_FLOOR_MS;
  return Math.min(Math.max(wait, PROVIDER_RETRY_FLOOR_MS), PROVIDER_RETRY_CEIL_MS);
}

// The ai_calls error code for a failed model call (never the provider's message).
export function aiErrorCode(error: unknown): string {
  if (error instanceof AiProviderError) {
    return error.kind === "auth_failed" ? "provider_auth_failed" : "provider_error";
  }
  if (error instanceof AiQuotaError) return "quota_deferred";
  if (error instanceof AiOutputError) return "invalid_output";
  if (error instanceof AiPolicyError) return error.code;
  return "provider_error";
}
