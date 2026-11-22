import type { BankQuery } from "../schema/bank-query";

export const BANK_PATH = "/question-bank";

// The query keys that narrow the list (sort and page do not).
export const FILTER_KEYS = [
  "grade",
  "topicId",
  "elementId",
  "difficulty",
  "type",
  "status",
  "origin",
  "from",
  "to",
  "q",
] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];

export function hasActiveFilters(query: BankQuery): boolean {
  return FILTER_KEYS.some((key) => query[key] !== undefined);
}

// The params a link or form must carry to keep the current view. Defaults (newest, page 1) are left
// out so the URL stays short; `except` drops keys the caller supplies itself.
export function bankParams(
  query: BankQuery,
  except: readonly (keyof BankQuery)[] = [],
): [string, string][] {
  const params: [string, string][] = [];
  for (const key of FILTER_KEYS) {
    const value = query[key];
    if (value !== undefined && !except.includes(key)) params.push([key, String(value)]);
  }
  if (query.sort !== "newest" && !except.includes("sort")) {
    params.push(["sort", query.sort]);
  }
  if (query.page > 1 && !except.includes("page")) {
    params.push(["page", String(query.page)]);
  }
  return params;
}

// A link to the bank with the current view changed by `patch` (an undefined value removes a key).
// Any change goes back to page 1 unless the patch names a page.
export function bankHref(query: BankQuery, patch: Partial<BankQuery> = {}): string {
  const next: BankQuery = { ...query, ...patch };
  if (!("page" in patch)) next.page = 1;
  const text = new URLSearchParams(bankParams(next)).toString();
  return text ? `${BANK_PATH}?${text}` : BANK_PATH;
}
