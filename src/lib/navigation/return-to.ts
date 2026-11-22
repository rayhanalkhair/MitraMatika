/**
 * Where the editor goes after saving or cancelling: the `next` search param when it is a path inside
 * the app (a single leading slash, no backslash or control character), else `fallback`.
 */
export function safeReturnTo(
  next: string | string[] | undefined,
  fallback: string,
): string {
  if (typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  if (/[\\\u0000-\u001f]/.test(next)) return fallback;
  return next;
}

// The way back from /generate to an assessment editor: only `/assessment-builder/<id>`, optionally
// with `?since=<ISO time>` (the editor offers the questions banked since then). Anything else is
// dropped, so a hand-made link cannot send the teacher elsewhere.
const EDITOR_PATH =
  /^\/assessment-builder\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\?since=[0-9A-Za-z:.+%-]{10,40})?$/i;

/** The editor path in `value`, or null when it is missing or not an editor path. */
export function assessmentReturnTo(value: string | string[] | undefined): string | null {
  const safe = safeReturnTo(value, "");
  return safe !== "" && EDITOR_PATH.test(safe) ? safe : null;
}

/** The link from the editor to the generator, carrying the way back. */
export function generateHref(assessmentId: string, sinceIso: string): string {
  const back = `/assessment-builder/${assessmentId}?since=${encodeURIComponent(sinceIso)}`;
  return `/generate?returnTo=${encodeURIComponent(back)}`;
}

/** The `since` time of the editor link, as a Date; null when absent or not a real time. */
export function parseSince(value: string | string[] | undefined): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
