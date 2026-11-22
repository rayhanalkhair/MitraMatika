import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { MATERIAL_STATUSES, type MaterialQuery } from "../schema/library";
import { MATERIALS_PATH } from "./materials-href";
import { control, primaryButton } from "./styles";

// No "use client": a plain GET form, so search and filters work without JavaScript and every
// result has a link of its own. The folder being viewed is kept in a hidden field.
/** Search over titles and page text, and the grade, academic year and status filters. */
export function MaterialFilters({
  query,
  years,
}: {
  query: MaterialQuery;
  years: string[];
}) {
  const t = useTranslations("materials.library");
  const yearOptions =
    query.year && !years.includes(query.year) ? [query.year, ...years] : years;
  return (
    <form
      method="get"
      action={MATERIALS_PATH}
      role="search"
      aria-label={t("filters.label")}
      className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 shadow-card"
    >
      {query.folder ? <input type="hidden" name="folder" value={query.folder} /> : null}
      <div className="relative min-w-0">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          name="q"
          defaultValue={query.q ?? ""}
          maxLength={100}
          aria-label={t("search.label")}
          placeholder={t("search.placeholder")}
          className={`${control} pl-9`}
        />
      </div>
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
          {t("filters.grade")}
          <select name="grade" defaultValue={query.grade ?? ""} className={control}>
            <option value="">{t("filters.any")}</option>
            {[7, 8, 9].map((grade) => (
              <option key={grade} value={grade}>
                {t("grade", { grade })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
          {t("filters.year")}
          <select name="year" defaultValue={query.year ?? ""} className={control}>
            <option value="">{t("filters.any")}</option>
            {yearOptions.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
          {t("filters.status")}
          <select name="status" defaultValue={query.status ?? ""} className={control}>
            <option value="">{t("filters.any")}</option>
            {MATERIAL_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`status.${status}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button type="submit" className={`${primaryButton} self-start`}>
        {t("filters.apply")}
      </button>
    </form>
  );
}
