import type { MaterialQuery } from "../schema/library";

export const MATERIALS_PATH = "/materials";

type Param = "folder" | "grade" | "year" | "status" | "q" | "page";
type Changes = Partial<Record<Param, string | number | undefined>>;

/**
 * The list's URL for `query` with `changes` applied, in a stable order and without defaults. A
 * change that is not the page starts again at page 1; `undefined` drops a param.
 */
export function materialsHref(query: MaterialQuery, changes: Changes = {}): string {
  const current: Changes = {
    folder: query.folder,
    grade: query.grade,
    year: query.year,
    status: query.status,
    q: query.q,
    page: "page" in changes ? changes.page : 1,
  };
  const merged: Changes = { ...current, ...changes };
  const params = new URLSearchParams();
  for (const name of ["folder", "grade", "year", "status", "q"] as const) {
    const value = merged[name];
    if (value !== undefined) params.set(name, String(value));
  }
  if (merged.page !== undefined && Number(merged.page) > 1) {
    params.set("page", String(merged.page));
  }
  const search = params.toString();
  return search ? `${MATERIALS_PATH}?${search}` : MATERIALS_PATH;
}

export const hasFilters = (query: MaterialQuery) =>
  query.grade !== undefined ||
  query.year !== undefined ||
  query.status !== undefined ||
  query.q !== undefined;
