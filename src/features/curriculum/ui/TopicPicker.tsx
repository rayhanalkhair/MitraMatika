"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useFormContext, type UseFormReturn } from "react-hook-form";
import { CurriculumChip } from "@/components/curriculum/CurriculumChip";
import { TopicErrorContext } from "@/features/generation/ui/topic-error-context";
import {
  filterTopics,
  groupByElement,
  pickerHref,
} from "@/features/curriculum/service/picker";
import type {
  CurriculumVersion,
  TopicWithObjectives,
} from "@/features/curriculum/service/repository";

// One quiet colour per curriculum element: a dot beside its heading, never the only cue.
const ELEMENT_DOTS = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
] as const;

// The part of an enclosing form this picker fills in.
interface TopicFormValues {
  topic: string;
}

interface Props {
  topics: TopicWithObjectives[];
  version: CurriculumVersion;
  selectedKey: string | null;
}

export function TopicPicker({ topics, version, selectedKey }: Props) {
  const t = useTranslations("buatSoal");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(selectedKey);
  // The URL is the source of truth: when the prop changes while mounted (nav link, back/forward),
  // resync during render. Local state still shows a click immediately.
  const [seenKey, setSeenKey] = useState<string | null>(selectedKey);
  if (seenKey !== selectedKey) {
    setSeenKey(selectedKey);
    setSelected(selectedKey);
  }
  const errorId = useContext(TopicErrorContext);
  // Inside the generation form (React Hook Form) the choice is also the form's `topic` value, so
  // the browser check sees it; outside a form the picker works alone. Validated live only after a
  // submit, like every other field.
  // useFormContext is typed non-null but returns null outside a FormProvider, so widen it.
  const form = useFormContext<TopicFormValues>() as UseFormReturn<TopicFormValues> | null;
  function setFormTopic(key: string | null) {
    form?.setValue("topic", key ?? "", { shouldValidate: form.formState.isSubmitted });
  }
  // The URL changed while mounted (nav link, back/forward, the page catching up with a choice).
  const syncFormTopic = useEffectEvent(setFormTopic);
  useEffect(() => {
    syncFormTopic(selectedKey);
  }, [selectedKey]);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLFieldSetElement>(null);

  const visible = useMemo(() => filterTopics(topics, query), [topics, query]);
  const groups = useMemo(() => groupByElement(visible), [visible]);
  const selectedTopic = topics.find((t) => t.stableKey === selected) ?? null;
  const trimmed = query.trim();

  function clearSelection() {
    select(null);
    // The clear button unmounts: hand focus to the first visible topic, else the search box.
    const firstRadio =
      listRef.current?.querySelector<HTMLInputElement>('input[type="radio"]');
    (firstRadio ?? searchRef.current)?.focus();
  }

  function clearSearch() {
    setQuery("");
    searchRef.current?.focus();
  }

  function select(key: string | null) {
    setSelected(key);
    setFormTopic(key);
    startTransition(() => {
      router.replace(pickerHref(8, key), { scroll: false });
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label htmlFor="search-topic" className="font-heading text-sm font-semibold">
          {t("searchLabel")}
        </label>
        <div className="flex gap-2">
          <input
            id="search-topic"
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              // The picker sits inside the generation form: Enter must not submit it.
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder={t("searchPlaceholder")}
            autoComplete="off"
            className="min-h-11 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-base transition-colors duration-150 placeholder:text-muted-foreground"
          />
          {trimmed !== "" && (
            <button
              type="button"
              onClick={clearSearch}
              className="min-h-11 shrink-0 rounded-lg border border-input bg-card px-3 text-sm font-medium transition-colors duration-150 hover:bg-secondary"
            >
              {t("clearSearch")}
            </button>
          )}
        </div>
        <p role="status" className="text-sm break-words text-muted-foreground">
          {visible.length === 0
            ? t("noMatch", { query: trimmed })
            : t("resultCount", { count: visible.length })}
        </p>
      </div>

      {/* Visible radios come and go with the search filter, so the choice is posted from state. */}
      <input type="hidden" name="topic" value={selected ?? ""} />
      <fieldset
        ref={listRef}
        aria-describedby={errorId}
        // The form's focus moves here after a failed submit (a radio cannot carry aria-invalid).
        data-invalid={errorId ? "true" : undefined}
        className="flex flex-col gap-6"
      >
        <legend className="sr-only">{t("topicsLegend")}</legend>
        <div className="grid gap-6 lg:grid-cols-2">
          {groups.map((group, groupIndex) => (
            <div key={group.element.code}>
              <h3 className="mb-2 flex items-center gap-2 font-heading text-base font-bold">
                <span
                  aria-hidden="true"
                  className={`size-2.5 shrink-0 rounded-full ${
                    ELEMENT_DOTS[groupIndex % ELEMENT_DOTS.length]
                  }`}
                />
                {group.element.name}
              </h3>
              <ul className="flex flex-col gap-3">
                {group.topics.map((topic) => {
                  const inputId = `topic-${topic.stableKey}`;
                  return (
                    <li
                      key={topic.stableKey}
                      className={`rounded-lg border p-3.5 transition-colors duration-150 ${
                        selected === topic.stableKey
                          ? "border-primary bg-accent ring-2 ring-primary"
                          : "border-border bg-card hover:border-primary/40"
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <input
                          type="radio"
                          name="topic-choice"
                          id={inputId}
                          value={topic.stableKey}
                          checked={selected === topic.stableKey}
                          onChange={() => {
                            select(topic.stableKey);
                          }}
                          className="mt-1 size-5 shrink-0 accent-primary"
                        />
                        <label
                          htmlFor={inputId}
                          className="flex min-h-11 flex-1 flex-col gap-1"
                        >
                          <span className="font-heading font-semibold">
                            {topic.title}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            {topic.scopeNotes}
                          </span>
                        </label>
                      </div>
                      {topic.objectives.length > 0 && (
                        <ul className="mt-2 flex flex-wrap gap-1.5 pl-8">
                          {topic.objectives.map((objective) => (
                            <li key={objective.id}>
                              <CurriculumChip code={objective.code} />
                            </li>
                          ))}
                        </ul>
                      )}
                      <details className="mt-2 pl-8">
                        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-primary">
                          {t("objectivesSummary", {
                            count: String(topic.objectives.length),
                          })}
                        </summary>
                        {topic.objectives.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            {t("noObjectives")}
                          </p>
                        ) : (
                          <ul className="list-disc pl-5 text-sm">
                            {topic.objectives.map((objective) => (
                              <li key={objective.id}>
                                <span className="font-medium">{objective.code}</span>{" "}
                                {objective.text}
                              </li>
                            ))}
                          </ul>
                        )}
                      </details>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </fieldset>

      <section
        aria-labelledby="selected-topic"
        aria-live="polite"
        className="flex flex-col gap-2 rounded-lg border border-accent bg-accent/50 p-5"
      >
        <h3 id="selected-topic" className="font-heading text-base font-bold">
          {t("selectedHeading")}
        </h3>
        {selectedTopic ? (
          <div className="flex flex-col gap-2">
            <h4 className="font-heading font-semibold">{selectedTopic.title}</h4>
            <p className="text-sm text-muted-foreground">
              {t("selectedElement")}: {selectedTopic.element.name}
            </p>
            <ul className="list-disc pl-5 text-sm">
              {selectedTopic.objectives.map((objective) => (
                <li key={objective.id}>
                  <span className="font-medium">{objective.code}</span> {objective.text}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={clearSelection}
              className="min-h-11 self-start rounded-lg border border-input bg-card px-3 text-sm font-medium transition-colors duration-150 hover:bg-secondary"
            >
              {t("clearSelection")}
            </button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("nothingSelected")}</p>
        )}
      </section>

      <p className="text-sm text-muted-foreground">
        {t("sourcePrefix")} {version.sourceTitle}, {t("versionWord")} {version.code}.{" "}
        <a
          href={version.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-primary underline underline-offset-4"
        >
          {t("openSource")}
          <span aria-hidden="true"> ↗</span>
          <span className="sr-only"> {t("opensInNewTab")}</span>
        </a>
      </p>
    </div>
  );
}
