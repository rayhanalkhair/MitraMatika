import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  BookOpenCheck,
  ChevronLeft,
  ChevronRight,
  FileImage,
  FileText,
  FolderOpen,
  Search,
} from "lucide-react";
import { StatusPill } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";
import type { MaterialQuery } from "../schema/library";
import type { MaterialListItem } from "../service/library";
import { hasFilters, MATERIALS_PATH, materialsHref } from "./materials-href";
import { STATUS_META, statusOf } from "./status-meta";
import { card } from "./styles";

const CELL =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border px-3 text-sm font-medium transition-colors duration-150";

// No "use client": a Server Component of the materials page.
/**
 * The materials as cards: kind, title (a link to the detail page), status (icon and words),
 * grade, academic year, pages, folder, and where a search matched. Two empty states: nothing
 * uploaded yet, or nothing matches the search and filters (with a way back).
 */
export function MaterialList({
  items,
  libraryTotal,
  query,
}: {
  items: MaterialListItem[];
  /** All of the teacher's materials, whatever the filters. */
  libraryTotal: number;
  query: MaterialQuery;
}) {
  const t = useTranslations("materials.library");
  if (items.length === 0) {
    const filtered = hasFilters(query) || query.folder !== undefined;
    return (
      <div className="flex min-w-0 flex-col items-center gap-3 rounded-lg border bg-card px-6 py-12 text-center shadow-card">
        <span
          aria-hidden="true"
          className="flex size-14 items-center justify-center rounded-lg bg-accent text-primary"
        >
          {filtered ? <Search className="size-7" /> : <FolderOpen className="size-7" />}
        </span>
        <p className="font-heading text-lg font-bold">
          {libraryTotal > 0 && filtered ? t("noMatches") : t("empty")}
        </p>
        {libraryTotal > 0 && filtered ? (
          <Link
            href={MATERIALS_PATH}
            className="inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline"
          >
            {t("resetFilters")}
          </Link>
        ) : (
          <p className="max-w-sm text-sm text-muted-foreground">{t("emptyHint")}</p>
        )}
      </div>
    );
  }
  return (
    <ul aria-label={t("listLabel")} className="grid min-w-0 gap-3 lg:grid-cols-2">
      {items.map((item) => {
        const status = statusOf(item.status);
        const { tone, icon: StatusIcon } = STATUS_META[status];
        const KindIcon = item.kind === "image" ? FileImage : FileText;
        return (
          <li key={item.id} className={card}>
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden="true"
                className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-accent text-primary"
              >
                <KindIcon className="size-5" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Link
                  href={`${MATERIALS_PATH}/${item.id}`}
                  className="min-h-11 font-heading font-semibold break-words text-foreground hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {item.title}
                </Link>
                <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  <span>
                    {t(
                      `kind.${item.kind === "docx" || item.kind === "image" ? item.kind : "pdf"}`,
                    )}
                  </span>
                  {item.grade !== null && (
                    <span>{t("grade", { grade: item.grade })}</span>
                  )}
                  {item.academicYear !== null && <span>{item.academicYear}</span>}
                  {item.pageCount !== null && (
                    <span>{t("pages", { count: item.pageCount })}</span>
                  )}
                  {item.folderName !== null && (
                    <span>{t("inFolder", { name: item.folderName })}</span>
                  )}
                </span>
              </div>
            </div>
            <span className="flex flex-wrap items-center gap-2">
              <StatusPill tone={tone}>
                <StatusIcon aria-hidden="true" className="size-4" />
                {t(`status.${status}`)}
              </StatusPill>
              {item.structureConfirmed && (
                <StatusPill tone="ai">
                  <BookOpenCheck aria-hidden="true" className="size-4" />
                  {t("structureConfirmed")}
                </StatusPill>
              )}
              {item.matchPage !== null && (
                <span className="text-sm font-medium text-foreground">
                  {t("matchPage", { page: item.matchPage })}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** "1–20 of 23 materials" and the page links (first, last, current and its neighbours). */
export function MaterialPagination({
  query,
  page,
  pageCount,
  total,
  shown,
  pageSize,
}: {
  query: MaterialQuery;
  page: number;
  pageCount: number;
  total: number;
  shown: number;
  pageSize: number;
}) {
  const t = useTranslations("materials.library");
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const pages = [...new Set([1, page - 1, page, page + 1, pageCount])]
    .filter((n) => n >= 1 && n <= pageCount)
    .sort((a, b) => a - b);
  return (
    <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
      <p className="text-sm text-muted-foreground">
        {t("showing", { first, last: first + shown - 1, total })}
      </p>
      {pageCount > 1 && (
        <nav aria-label={t("pagination.label")}>
          <ul className="flex flex-wrap items-center justify-center gap-2">
            {page > 1 && (
              <li>
                <Link
                  href={materialsHref(query, { page: page - 1 })}
                  rel="prev"
                  className={cn(CELL, "gap-1 bg-card hover:bg-accent")}
                >
                  <ChevronLeft aria-hidden="true" className="size-4" />
                  {t("pagination.previous")}
                </Link>
              </li>
            )}
            {pages.map((n) => (
              <li key={n}>
                <Link
                  href={materialsHref(query, { page: n })}
                  aria-label={t("pagination.page", { page: n })}
                  aria-current={n === page ? "page" : undefined}
                  className={cn(
                    CELL,
                    n === page
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-card hover:bg-accent",
                  )}
                >
                  {n}
                </Link>
              </li>
            ))}
            {page < pageCount && (
              <li>
                <Link
                  href={materialsHref(query, { page: page + 1 })}
                  rel="next"
                  className={cn(CELL, "gap-1 bg-card hover:bg-accent")}
                >
                  {t("pagination.next")}
                  <ChevronRight aria-hidden="true" className="size-4" />
                </Link>
              </li>
            )}
          </ul>
        </nav>
      )}
    </div>
  );
}
