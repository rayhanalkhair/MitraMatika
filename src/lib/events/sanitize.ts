const NAME = /^[a-z][a-z0-9_:.-]{2,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_JSON_BYTES = 4096;
const DEFAULT_MESSAGE_LENGTH = 500;
const TRUNCATED = { truncated: true } as const;

export function isValidEventName(value: unknown): value is string {
  return typeof value === "string" && NAME.test(value);
}

export function normalizeUuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Makes the value safe for a jsonb column: lone surrogates are repaired (Postgres rejects them),
// and anything over MAX_JSON_BYTES is replaced by a marker so one record cannot bloat the table.
export function clampJson(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) return {};
  try {
    const text = JSON.stringify(value, (_key, item: unknown): unknown =>
      typeof item === "string" ? item.toWellFormed() : item,
    );
    if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) return { ...TRUNCATED };
    // toJSON (a Date, say) can turn the value into a primitive or null; the column is NOT NULL jsonb.
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return { ...TRUNCATED };
  }
}

// Truncates by code point (never splitting a surrogate pair) and repairs lone surrogates.
export function truncateMessage(text: string, max = DEFAULT_MESSAGE_LENGTH): string {
  const chars = Array.from(text.toWellFormed());
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("");
}
