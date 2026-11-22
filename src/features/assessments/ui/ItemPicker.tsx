import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useId, useRef } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import type { BankList, BankQuery } from "@/features/bank";
import { bankParams } from "@/features/bank/ui/bank-href";
import { cn } from "@/lib/utils";
import { PickList } from "./PickList";
import { control, iconButton, linkButton, primaryButton } from "./styles";
import type { RunEditorAction } from "./use-editor-run";

const FILTER_FIELDS = ["grade", "topicId", "difficulty"] as const;

/** A link to the editor with the picker open on `pick` and the bank view `query` (patched). */
export function pickerHref(
  basePath: string,
  pick: string,
  query: BankQuery,
  patch: Partial<BankQuery> = {},
): string {
  const params = new URLSearchParams(bankParams({ ...query, ...patch }));
  params.set("pick", pick);
  return `${basePath}?${params.toString()}#picker`;
}

/**
 * The picker panel: the bank's search and filters (the same query as the Bank Soal page, kept in
 * the URL), one page of banked questions to check, and the form that adds them to the chosen
 * section. It takes focus when it opens.
 */
export function ItemPicker({
  assessmentId,
  basePath,
  sections,
  pickSectionId,
  query,
  list,
  added,
  pending,
  locked,
  busy,
  run,
}: {
  assessmentId: string;
  basePath: string;
  sections: { id: string; title: string }[];
  pickSectionId: string;
  query: BankQuery;
  list: BankList;
  added: string[];
  pending: string[];
  locked: boolean;
  busy: boolean;
  run: RunEditorAction;
}) {
  const t = useTranslations("assessments");
  const tb = useTranslations("bank");
  const tf = useTranslations("bank.filters");
  const tr = useTranslations("review");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const section = sections.find((s) => s.id === pickSectionId);
  const bankEmpty = list.facets.grades.length === 0;

  useEffect(() => {
    headingRef.current?.focus();
  }, [pickSectionId]);

  const items = list.items.map((item) => ({
    questionId: item.questionId,
    stemExcerptMd: item.stemExcerptMd,
    meta: [item.topicTitle, tr(`difficulty.${item.difficulty}`)]
      .filter((part) => part !== "")
      .join(" · "),
    added: added.includes(item.questionId),
    pending: pending.includes(item.questionId),
  }));

  return (
    <section
      id="picker"
      aria-labelledby="picker-heading"
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-primary/30 bg-card p-4 shadow-card"
    >
      <div className="flex items-start justify-between gap-3">
        <h2
          id="picker-heading"
          ref={headingRef}
          tabIndex={-1}
          className="font-heading text-lg font-bold break-words"
        >
          {t("picker.heading", { section: section?.title ?? "" })}
        </h2>
        <Link href={basePath} aria-label={t("picker.close")} className={iconButton}>
          <X aria-hidden="true" className="size-5" />
        </Link>
      </div>

      {bankEmpty ? (
        <p className="text-sm text-muted-foreground">{t("picker.emptyBank")}</p>
      ) : (
        <>
          <form
            method="get"
            action={basePath}
            role="search"
            className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <input type="hidden" name="pick" value={pickSectionId} />
            <div className="relative min-w-0 sm:col-span-2 lg:col-span-4">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                name="q"
                defaultValue={query.q ?? ""}
                maxLength={100}
                aria-label={tb("search.label")}
                placeholder={tb("search.placeholder")}
                className={cn(control, "pl-9")}
              />
            </div>
            <Filter label={tf("grade")} id={`${id}-grade`}>
              <select
                id={`${id}-grade`}
                name="grade"
                defaultValue={query.grade ?? ""}
                className={control}
              >
                <option value="">{tf("all")}</option>
                {list.facets.grades.map((grade) => (
                  <option key={grade} value={grade}>
                    {tf("gradeOption", { grade })}
                  </option>
                ))}
              </select>
            </Filter>
            <Filter label={tf("topic")} id={`${id}-topic`}>
              <select
                id={`${id}-topic`}
                name="topicId"
                defaultValue={query.topicId ?? ""}
                className={control}
              >
                <option value="">{tf("all")}</option>
                {list.facets.topics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.title}
                  </option>
                ))}
              </select>
            </Filter>
            <Filter label={tf("difficulty")} id={`${id}-difficulty`}>
              <select
                id={`${id}-difficulty`}
                name="difficulty"
                defaultValue={query.difficulty ?? ""}
                className={control}
              >
                <option value="">{tf("all")}</option>
                {(["mudah", "sedang", "sulit"] as const).map((value) => (
                  <option key={value} value={value}>
                    {tr(`difficulty.${value}`)}
                  </option>
                ))}
              </select>
            </Filter>
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-4">
              <button type="submit" className={primaryButton}>
                {tf("apply")}
              </button>
              {FILTER_FIELDS.some((key) => query[key] !== undefined) ||
              query.q !== undefined ? (
                <Link
                  href={`${basePath}?pick=${pickSectionId}#picker`}
                  className={linkButton}
                >
                  {tf("reset")}
                </Link>
              ) : null}
            </div>
          </form>

          {items.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("picker.none")}
            </p>
          ) : (
            <PickList
              // A new page or filter starts with nothing checked.
              key={`${String(list.page)}-${items.map((i) => i.questionId).join(",")}`}
              assessmentId={assessmentId}
              items={items}
              sections={sections}
              initialSectionId={pickSectionId}
              focusAfterAdd="picker-heading"
              locked={locked}
              busy={busy}
              run={run}
            />
          )}

          {list.pageCount > 1 && (
            <nav
              aria-label={t("picker.pageLabel")}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              {list.page > 1 ? (
                <Link
                  href={pickerHref(basePath, pickSectionId, query, {
                    page: list.page - 1,
                  })}
                  rel="prev"
                  className={linkButton}
                >
                  <ChevronLeft aria-hidden="true" className="size-4" />
                  {t("picker.previous")}
                </Link>
              ) : (
                <span />
              )}
              <span className="text-sm text-muted-foreground">
                {t("picker.page", { page: list.page, pageCount: list.pageCount })}
              </span>
              {list.page < list.pageCount ? (
                <Link
                  href={pickerHref(basePath, pickSectionId, query, {
                    page: list.page + 1,
                  })}
                  rel="next"
                  className={linkButton}
                >
                  {t("picker.next")}
                  <ChevronRight aria-hidden="true" className="size-4" />
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </section>
  );
}

function Filter({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
