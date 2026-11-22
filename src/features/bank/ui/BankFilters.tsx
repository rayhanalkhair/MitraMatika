"use client";

import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { ListFilter, X } from "lucide-react";
import { formatBankDate } from "@/lib/format-date";
import { cn } from "@/lib/utils";
import { BANK_SORTS, BANK_STATUSES, type BankQuery } from "../schema/bank-query";
import {
  BANK_PATH,
  bankHref,
  bankParams,
  hasActiveFilters,
  type FilterKey,
} from "./bank-href";

export interface BankFacets {
  grades: number[];
  elements: { id: string; name: string }[];
  topics: { id: string; title: string }[];
}

const CONTROL =
  "min-h-11 w-full min-w-0 rounded-lg border bg-card px-3 text-sm text-foreground";
const BUTTON =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors duration-150";

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

// The facet controls, a GET form (works without JavaScript; the URL is the state). Wide screens show
// it inline; on a phone it opens as a full-screen sheet from the "Filter" button.
export function BankFilters({ query, facets }: { query: BankQuery; facets: BankFacets }) {
  const t = useTranslations("bank.filters");
  const tr = useTranslations("review");
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const wasOpen = useRef(false);
  const active = (
    ["grade", "elementId", "topicId", "difficulty", "status", "from", "to"] as const
  ).filter((key) => query[key] !== undefined).length;

  useEffect(() => {
    if (open) {
      formRef.current
        ?.querySelector<HTMLElement>("select, input:not([type=hidden])")
        ?.focus();
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setOpen(false);
        }
      };
      document.addEventListener("keydown", onKey);
      // At lg the form is inline, not a sheet: close it so it is no longer a modal dialog.
      const wide = window.matchMedia("(min-width: 1024px)");
      const onWide = (event: MediaQueryListEvent) => {
        if (event.matches) setOpen(false);
      };
      wide.addEventListener("change", onWide);
      wasOpen.current = true;
      return () => {
        document.removeEventListener("keydown", onKey);
        wide.removeEventListener("change", onWide);
      };
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      buttonRef.current?.focus();
    }
  }, [open]);

  // Empty controls stay out of the URL: a disabled field is not submitted.
  // They are enabled again right after, so a back navigation does not restore disabled controls.
  function dropEmpty(event: SyntheticEvent<HTMLFormElement>) {
    const dropped: (HTMLSelectElement | HTMLInputElement)[] = [];
    for (const el of event.currentTarget.elements) {
      if (
        (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) &&
        el.type !== "hidden" &&
        el.value === ""
      ) {
        el.disabled = true;
        dropped.push(el);
      }
    }
    setTimeout(() => {
      for (const el of dropped) el.disabled = false;
    }, 0);
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
        }}
        className={cn(BUTTON, "border bg-card hover:bg-accent lg:hidden")}
      >
        <ListFilter aria-hidden="true" className="size-4" />
        {t("open")}
        {active > 0 && (
          <span className="rounded-full bg-primary px-2 text-xs text-primary-foreground">
            {active}
          </span>
        )}
      </button>
      <form
        ref={formRef}
        method="get"
        action={BANK_PATH}
        onSubmit={dropEmpty}
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-label={t("heading")}
        className={cn(
          open
            ? "fixed inset-0 z-50 flex flex-col gap-4 overflow-y-auto bg-background p-4"
            : "hidden",
          "lg:static lg:z-auto lg:grid lg:grid-cols-4 lg:items-end lg:gap-3 lg:overflow-visible lg:bg-transparent lg:p-0",
        )}
      >
        <div className="flex items-center justify-between lg:hidden">
          <h2 className="font-heading text-lg font-bold">{t("heading")}</h2>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
            aria-label={t("close")}
            className={cn(BUTTON, "size-11 border bg-card px-0 hover:bg-accent")}
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        {bankParams(query, [
          "grade",
          "elementId",
          "topicId",
          "difficulty",
          "status",
          "from",
          "to",
          "sort",
          "page",
        ]).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <Field label={t("grade")} htmlFor="bank-grade">
          <select
            id="bank-grade"
            name="grade"
            defaultValue={query.grade ?? ""}
            className={CONTROL}
          >
            <option value="">{t("all")}</option>
            {facets.grades.map((grade) => (
              <option key={grade} value={grade}>
                {t("gradeOption", { grade })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("element")} htmlFor="bank-element">
          <select
            id="bank-element"
            name="elementId"
            defaultValue={query.elementId ?? ""}
            className={CONTROL}
          >
            <option value="">{t("all")}</option>
            {facets.elements.map((element) => (
              <option key={element.id} value={element.id}>
                {element.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("topic")} htmlFor="bank-topic">
          <select
            id="bank-topic"
            name="topicId"
            defaultValue={query.topicId ?? ""}
            className={CONTROL}
          >
            <option value="">{t("all")}</option>
            {facets.topics.map((topic) => (
              <option key={topic.id} value={topic.id}>
                {topic.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("difficulty")} htmlFor="bank-difficulty">
          <select
            id="bank-difficulty"
            name="difficulty"
            defaultValue={query.difficulty ?? ""}
            className={CONTROL}
          >
            <option value="">{t("all")}</option>
            {(["mudah", "sedang", "sulit"] as const).map((value) => (
              <option key={value} value={value}>
                {tr(`difficulty.${value}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("status")} htmlFor="bank-status">
          <select
            id="bank-status"
            name="status"
            defaultValue={query.status ?? ""}
            className={CONTROL}
          >
            <option value="">{t("all")}</option>
            {BANK_STATUSES.map((value) => (
              <option key={value} value={value}>
                {tr(`statuses.${value}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("from")} htmlFor="bank-from">
          <input
            id="bank-from"
            type="date"
            name="from"
            defaultValue={query.from ?? ""}
            className={CONTROL}
          />
        </Field>
        <Field label={t("to")} htmlFor="bank-to">
          <input
            id="bank-to"
            type="date"
            name="to"
            defaultValue={query.to ?? ""}
            className={CONTROL}
          />
        </Field>
        <Field label={t("sort")} htmlFor="bank-sort">
          <select
            id="bank-sort"
            name="sort"
            defaultValue={query.sort}
            className={CONTROL}
          >
            {BANK_SORTS.map((value) => (
              <option key={value} value={value}>
                {t(`sorts.${value}`)}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex flex-wrap gap-2 lg:col-span-4 lg:justify-end">
          <button
            type="submit"
            className={cn(
              BUTTON,
              "bg-primary text-primary-foreground hover:bg-primary-hover",
            )}
          >
            {t("apply")}
          </button>
          {hasActiveFilters(query) && (
            <Link
              href={BANK_PATH}
              className={cn(BUTTON, "border bg-card hover:bg-accent")}
            >
              {t("reset")}
            </Link>
          )}
        </div>
      </form>
    </div>
  );
}

// One removable pill per active filter (a link that drops just that filter) and a reset link.
export function ActiveFilters({
  query,
  facets,
}: {
  query: BankQuery;
  facets: BankFacets;
}) {
  const t = useTranslations("bank.filters");
  const tr = useTranslations("review");
  const locale = useLocale();
  // A date-only value shown as a calendar date, whatever the viewer's timezone.
  const day = (value: string) =>
    formatBankDate(`${value}T12:00:00Z`, { locale, timeZone: "UTC" });
  const pills: { key: FilterKey; label: string; patch: Partial<BankQuery> }[] = [];
  const add = (key: FilterKey, label: string | undefined) => {
    if (label !== undefined) pills.push({ key, label, patch: { [key]: undefined } });
  };
  if (query.q !== undefined) add("q", t("pill.q", { q: query.q }));
  if (query.grade !== undefined) add("grade", t("gradeOption", { grade: query.grade }));
  if (query.elementId !== undefined) {
    add(
      "elementId",
      facets.elements.find((e) => e.id === query.elementId)?.name ?? t("unknown"),
    );
  }
  if (query.topicId !== undefined) {
    add(
      "topicId",
      facets.topics.find((x) => x.id === query.topicId)?.title ?? t("unknown"),
    );
  }
  if (query.difficulty !== undefined)
    add("difficulty", tr(`difficulty.${query.difficulty}`));
  if (query.status !== undefined) add("status", tr(`statuses.${query.status}`));
  if (query.from !== undefined) add("from", t("pill.from", { date: day(query.from) }));
  if (query.to !== undefined) add("to", t("pill.to", { date: day(query.to) }));
  if (query.origin !== undefined) add("origin", t(`origins.${query.origin}`));
  if (query.type !== undefined) add("type", t("pill.type"));
  if (pills.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t("active")}
      className="flex flex-wrap items-center gap-2"
    >
      {pills.map((pill) => (
        <Link
          key={pill.key}
          href={bankHref(query, pill.patch)}
          aria-label={t("remove", { label: pill.label })}
          className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-full border bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent/70"
        >
          <span className="min-w-0 truncate">{pill.label}</span>
          <X aria-hidden="true" className="size-4 shrink-0" />
        </Link>
      ))}
      <Link
        href={BANK_PATH}
        className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-primary underline-offset-4 hover:underline"
      >
        {t("reset")}
      </Link>
    </div>
  );
}
