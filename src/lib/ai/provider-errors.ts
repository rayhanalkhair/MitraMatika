import { AiProviderError, type AiProviderErrorKind } from "./types";

export const RETRY_AFTER_MIN_MS = 1_000;
export const RETRY_AFTER_MAX_MS = 3_600_000;

// `retry-after` is untrusted: delta-seconds or an HTTP date. Anything that is not a positive,
// finite wait is ignored; the rest is clamped so a hostile value cannot park a job for more than an
// hour or produce a time in the past.
export function parseRetryAfter(
  header: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  if (header === null) return undefined;
  const text = header.trim();
  if (text === "") return undefined;
  let waitMs: number;
  if (/^\d+(\.\d+)?$/.test(text)) {
    waitMs = Number(text) * 1_000;
  } else {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return undefined;
    waitMs = at - nowMs;
  }
  // A digit string too long to represent overflows to Infinity: that is "very long", not invalid.
  if (waitMs === Infinity) return RETRY_AFTER_MAX_MS;
  if (!Number.isFinite(waitMs) || waitMs <= 0) return undefined;
  return Math.min(Math.max(Math.round(waitMs), RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

export function classifyHttpFailure(
  status: number,
  retryAfterHeader: string | null,
  nowMs: number = Date.now(),
): { kind: AiProviderErrorKind; retryAfterMs?: number } {
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(retryAfterHeader, nowMs);
    return retryAfterMs === undefined
      ? { kind: "rate_limited" }
      : { kind: "rate_limited", retryAfterMs };
  }
  if (status === 408) return { kind: "timeout" };
  // A rejected or missing key is a misconfiguration, not an outage: retrying cannot fix it.
  if (status === 401 || status === 403) return { kind: "auth_failed" };
  return { kind: "unavailable" };
}

export function providerFailureMessage(kind: AiProviderErrorKind): string {
  switch (kind) {
    case "rate_limited":
      return "Layanan AI sedang membatasi permintaan.";
    case "timeout":
      return "Layanan AI tidak menjawab tepat waktu.";
    case "auth_failed":
      return "Layanan AI menolak kunci akses.";
    case "invalid_response":
      return "Layanan AI mengirim jawaban yang tidak dapat dibaca.";
    case "unavailable":
      return "Layanan AI sedang tidak dapat dijangkau.";
  }
}

const DETAIL_MAX_CHARS = 500;
const REDACTED = "[disembunyikan]";

// Removes credentials that a runtime or a provider may echo back: `key=`/`apikey=`/`api_key=` query
// values (the Gemini URL used to carry the key) and `Bearer` tokens.
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(api[_-]?key|key)=[^&\s]*/gi, `$1=${REDACTED}`)
    .replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`);
}

// The only way a technical string becomes `AiProviderError.detail`: redacted and bounded.
export function makeDetail(text: string): string {
  return redactSecrets(text).slice(0, DETAIL_MAX_CHARS);
}

// Anything a provider's fetch can throw becomes an AiProviderError: an aborted request is a
// timeout, any other failure (network, DNS, bad JSON of a success body) is "unavailable".
export function toProviderError(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) return error;
  const detail = makeDetail(error instanceof Error ? error.message : String(error));
  const aborted = error instanceof Error && error.name === "AbortError";
  const kind: AiProviderErrorKind = aborted ? "timeout" : "unavailable";
  return new AiProviderError(kind, providerFailureMessage(kind), { detail });
}
