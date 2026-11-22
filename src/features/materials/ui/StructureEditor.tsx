"use client";

import { useLocale, useTimeZone, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useId, useRef, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { Field } from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/SubmitButton";
import { StatusPill } from "@/components/ui/status-pill";
import { useFocusFirstInvalid } from "@/lib/forms/focus-first-invalid";
import { formatBankDate } from "@/lib/format-date";
import { isTerminal } from "@/lib/jobs/client/status";
import { useJobStatus } from "@/lib/jobs/client/use-job-status";
import { DEFAULT_TIMEZONE } from "@/lib/timezone-shared";
import {
  confirmStructureAction,
  requestStructureAction,
  type ConfirmStructureState,
  type RequestStructureState,
} from "../actions/structure";
import {
  MAX_CHAPTERS,
  MAX_SECTION_TITLE,
  structureFormSchema,
  USER_DAILY_STRUCTURE_PROPOSALS,
  type StoredProposal,
  type StructureFormValues,
  type StructureValues,
} from "../schema/structure";
import type { MaterialSectionItem } from "../service/library";
import type { StructureJobStatus } from "../service/structure";
import { LiveNotice, type Notice } from "./LiveNotice";
import {
  control,
  iconButton,
  noticeClass,
  primaryButton,
  secondaryButton,
} from "./styles";

export interface StructureTopic {
  id: string;
  title: string;
  grade: number;
}

type ChapterValues = StructureFormValues["chapters"][number];

/** A chapter as the form holds it: every value a string, a missing topic or end page blank. */
function chapterValues(chapter: {
  title: string;
  pageStart: number;
  pageEnd: number | null;
  topicId: string | null;
}): ChapterValues {
  return {
    title: chapter.title,
    pageStart: String(chapter.pageStart),
    pageEnd: String(chapter.pageEnd ?? chapter.pageStart),
    topicId: chapter.topicId ?? "",
  };
}
/** The path of one value of chapter `index` in the form. */
function chapterPath<K extends keyof ChapterValues>(index: number, name: K) {
  return `chapters.${String(index)}.${name}` as `chapters.${number}.${K}`;
}
const ACTIVE = ["queued", "running", "deferred"];
// The message of each top-level field that can be invalid (the schema's issue is one key for all).
const FIELD_ERROR_KEYS = {
  title: "titleInvalid",
  grade: "gradeInvalid",
  academicYear: "yearInvalid",
} as const;

/**
 * The structure of a material: title, grade, academic year and chapters with page ranges and a
 * curriculum topic each, all editable. "Suggest with AI" queues the proposal job and follows it;
 * a finished proposal re-renders the page, which hands the editor the suggested values (marked as
 * the AI's until saved). Saving confirms the structure. One live region announces each outcome.
 */
export function StructureEditor({
  materialId,
  status,
  pageCount,
  saved,
  proposal,
  topics,
  job,
}: {
  materialId: string;
  status: string;
  pageCount: number | null;
  saved: {
    title: string;
    grade: number | null;
    academicYear: string | null;
    metadataConfirmedAt: string | null;
    sections: MaterialSectionItem[];
  };
  proposal: StoredProposal | null;
  topics: StructureTopic[];
  job: StructureJobStatus | null;
}) {
  const t = useTranslations("materials.structure");
  const tLibrary = useTranslations("materials.library");
  const router = useRouter();
  const locale = useLocale();
  const timeZone = useTimeZone() ?? DEFAULT_TIMEZONE;
  const id = useId();

  // The AI's proposal shows when it is newer than the last confirmation. A new proposal remounts
  // the editor (the page keys it on the proposal's time), so the form starts from it here.
  const fromProposal =
    proposal !== null &&
    (saved.metadataConfirmedAt === null ||
      proposal.proposedAt > saved.metadataConfirmedAt);
  const [notice, setNotice] = useState<Notice>(null);
  // A refused submit shows its alert only while a field is still marked, so fixing the fields clears it.
  const [refused, setRefused] = useState(false);
  const [asking, setAsking] = useState(false);
  const [initial] = useState<StructureFormValues>(() => ({
    title: fromProposal ? proposal.title : saved.title,
    grade: String((fromProposal ? proposal.grade : saved.grade) ?? ""),
    academicYear: saved.academicYear ?? "",
    chapters: (fromProposal ? proposal.chapters : saved.sections).map(chapterValues),
  }));
  // The browser validates the typed strings with the schema the Server Action parses them with.
  // Submitted by hand, so a refused save keeps what was typed.
  const form = useForm<StructureFormValues, unknown, StructureValues>({
    resolver: zodResolver(structureFormSchema),
    defaultValues: initial,
    mode: "onSubmit",
    reValidateMode: "onChange",
    shouldFocusError: false,
  });
  const { register, setError, formState } = form;
  const { errors, submitCount, isSubmitting } = formState;
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "chapters",
    keyName: "fieldKey",
  });
  const formRef = useRef<HTMLFormElement>(null);
  // Focus moves to the first invalid field after a refused submit or a server refusal.
  const [serverRefusals, setServerRefusals] = useState(0);
  useFocusFirstInvalid(formRef, submitCount + serverRefusals);

  const [jobId, setJobId] = useState<string | null>(
    job && ACTIVE.includes(job.status) ? job.id : null,
  );
  const polled = useJobStatus(jobId);
  const followed =
    jobId !== null && polled.data?.kind === "ok" && polled.data.job.id === jobId
      ? polled.data.job
      : null;
  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (followed && isTerminal(followed.status) && settled.current !== followed.id) {
      settled.current = followed.id;
      if (followed.status === "succeeded") router.refresh();
    }
  }, [followed, router]);

  const readable = status === "ready" || status === "needs_review";
  const jobStatus = followed?.status ?? (jobId !== null ? "queued" : null);
  const running = jobStatus !== null && ACTIVE.includes(jobStatus);
  const failed =
    followed?.status === "failed" || (jobId === null && job?.status === "failed");

  function failureText(error: string): string {
    switch (error) {
      case "notFound":
      case "notReady":
      case "pages":
      case "topic":
      case "invalid":
      case "unauthenticated":
        return t(`errors.${error}`);
      case "limit":
        return t("errors.limit", { limit: USER_DAILY_STRUCTURE_PROPOSALS });
      default:
        return t("errors.generic");
    }
  }

  async function propose() {
    setAsking(true);
    // A refused save's alert is over once the teacher asks for something else.
    setRefused(false);
    setNotice(null);
    let result: RequestStructureState;
    try {
      result = await requestStructureAction({ materialId });
    } catch {
      result = { ok: false, error: "generic" };
    } finally {
      setAsking(false);
    }
    if (!result.ok) {
      setNotice({ kind: "alert", text: failureText(result.error) });
      return;
    }
    settled.current = null;
    setJobId(result.jobId);
  }

  /** A server refusal of the pages: mark the last-page input of each chapter that ends past the material's last page. */
  function markPages(chapters: ChapterValues[]) {
    if (pageCount === null) return;
    chapters.forEach((chapter, index) => {
      if (Number(chapter.pageEnd) > pageCount) {
        setError(chapterPath(index, "pageEnd"), {
          type: "server",
          message: "pages",
        });
      }
    });
    setServerRefusals((count) => count + 1);
  }

  const onValid = async () => {
    setRefused(false);
    setNotice(null);
    const values = form.getValues();
    let result: ConfirmStructureState;
    try {
      // The strings as typed: the action parses them with the same schema.
      result = await confirmStructureAction({ materialId, values });
    } catch {
      result = { ok: false, error: "generic" };
    }
    if (!result.ok) {
      if (result.error === "pages") markPages(values.chapters);
      setNotice({ kind: "alert", text: failureText(result.error) });
      return;
    }
    setNotice({ kind: "status", text: t("saved") });
    router.refresh();
  };
  const onSubmit = form.handleSubmit(onValid, () => {
    setRefused(true);
  });
  const shownNotice: Notice = refused
    ? Object.keys(errors).length > 0
      ? { kind: "alert", text: failureText("invalid") }
      : null
    : notice;

  /** The attributes of a chapter input: invalid when it has an error, tied to the chapter's text. */
  const chapterProps = (index: number, name: keyof ChapterValues, errorId: string) => {
    const invalid = errors.chapters?.[index]?.[name] !== undefined;
    return {
      "aria-invalid": invalid ? (true as const) : undefined,
      "aria-describedby": invalid ? errorId : undefined,
    };
  };
  /** The chapter's error text: the server's page refusal, else the one for a bad value. */
  function chapterError(index: number): string | undefined {
    const row = errors.chapters?.[index];
    if (!row) return undefined;
    const number = index + 1;
    if (row.pageEnd?.type === "server") {
      return t("chapterPages", { number, pages: pageCount ?? 0 });
    }
    return t("chapterInvalid", { number });
  }
  const fieldError = (name: keyof typeof FIELD_ERROR_KEYS) =>
    errors[name] ? t(FIELD_ERROR_KEYS[name]) : undefined;

  const grades = [7, 8, 9].filter((value) =>
    topics.some((topic) => topic.grade === value),
  );
  const maxPage = pageCount ?? undefined;
  const atLimit = fields.length >= MAX_CHAPTERS;

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-4 shadow-card sm:p-6"
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id={`${id}-heading`} className="font-heading text-lg font-semibold">
            {t("heading")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <button
          type="button"
          onClick={() => void propose()}
          disabled={!readable || running || asking}
          aria-busy={running || asking}
          className={`${secondaryButton} shrink-0`}
        >
          <Sparkles aria-hidden="true" className="size-4" />
          {proposal ? t("proposeAgain") : t("propose")}
        </button>
      </div>
      {!readable && <p className="text-sm text-muted-foreground">{t("notReady")}</p>}
      {running && (
        <p className="text-sm text-muted-foreground">
          {jobStatus === "deferred" ? t("waiting") : t("proposing")}
        </p>
      )}
      {failed && !running && <p className={noticeClass("alert")}>{t("errors.failed")}</p>}
      <span className="flex flex-wrap gap-2">
        {fromProposal && (
          <StatusPill tone="ai">
            <Sparkles aria-hidden="true" className="size-4" />
            {t("proposalNote")}
          </StatusPill>
        )}
        {saved.metadataConfirmedAt && (
          <span className="text-sm text-muted-foreground">
            {t("confirmedOn", {
              date: formatBankDate(saved.metadataConfirmedAt, { locale, timeZone }),
            })}
          </span>
        )}
      </span>

      <form
        ref={formRef}
        onSubmit={(event) => {
          void onSubmit(event);
        }}
        noValidate
        className="flex min-w-0 flex-col gap-4"
      >
        {/* Each control carries `defaultValue` next to `register`: the registration fills the
            value only once the page runs JavaScript, and the server render shows the saved
            structure. */}
        <div className="grid min-w-0 gap-3 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <Field id={`${id}-title`} label={t("title")} error={fieldError("title")}>
              {(a11y) => (
                <input
                  id={`${id}-title`}
                  {...register("title")}
                  aria-required="true"
                  defaultValue={initial.title}
                  maxLength={MAX_SECTION_TITLE}
                  {...a11y}
                  className={control}
                />
              )}
            </Field>
          </div>
          <Field id={`${id}-grade`} label={t("grade")} error={fieldError("grade")}>
            {(a11y) => (
              <select
                id={`${id}-grade`}
                {...register("grade")}
                defaultValue={initial.grade}
                {...a11y}
                className={control}
              >
                <option value="">{t("gradeNone")}</option>
                {[7, 8, 9].map((value) => (
                  <option key={value} value={value}>
                    {tLibrary("grade", { grade: value })}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            id={`${id}-year`}
            label={t("year")}
            hint={t("yearHint")}
            error={fieldError("academicYear")}
          >
            {(a11y) => (
              <input
                id={`${id}-year`}
                {...register("academicYear")}
                defaultValue={initial.academicYear}
                inputMode="numeric"
                {...a11y}
                className={control}
              />
            )}
          </Field>
        </div>

        <fieldset className="flex min-w-0 flex-col gap-3">
          <legend className="font-heading font-semibold">{t("chapters")}</legend>
          {fields.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("noChapters")}</p>
          )}
          <ol className="flex min-w-0 flex-col gap-3">
            {fields.map((field, index) => {
              const number = index + 1;
              const errorId = `${id}-chapter-${field.fieldKey}-error`;
              const error = chapterError(index);
              return (
                <li
                  key={field.fieldKey}
                  className="grid min-w-0 gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_6rem_6rem] lg:grid-cols-[1fr_6rem_6rem_14rem_auto]"
                >
                  <input
                    aria-label={t("chapterTitle", { number })}
                    {...register(chapterPath(index, "title"))}
                    aria-required="true"
                    defaultValue={field.title}
                    maxLength={MAX_SECTION_TITLE}
                    {...chapterProps(index, "title", errorId)}
                    className={control}
                  />
                  <input
                    aria-label={t("pageStart", { number })}
                    {...register(chapterPath(index, "pageStart"))}
                    aria-required="true"
                    defaultValue={field.pageStart}
                    type="number"
                    min={1}
                    max={maxPage}
                    {...chapterProps(index, "pageStart", errorId)}
                    className={control}
                  />
                  <input
                    aria-label={t("pageEnd", { number })}
                    {...register(chapterPath(index, "pageEnd"))}
                    aria-required="true"
                    defaultValue={field.pageEnd}
                    type="number"
                    min={1}
                    max={maxPage}
                    {...chapterProps(index, "pageEnd", errorId)}
                    className={control}
                  />
                  <select
                    aria-label={t("topic", { number })}
                    {...register(chapterPath(index, "topicId"))}
                    defaultValue={field.topicId}
                    {...chapterProps(index, "topicId", errorId)}
                    className={control}
                  >
                    <option value="">{t("topicNone")}</option>
                    {grades.map((value) => (
                      <optgroup key={value} label={tLibrary("grade", { grade: value })}>
                        {topics
                          .filter((topic) => topic.grade === value)
                          .map((topic) => (
                            <option key={topic.id} value={topic.id}>
                              {topic.title}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label={t("removeChapter", { number })}
                    onClick={() => {
                      remove(index);
                    }}
                    className={iconButton}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </button>
                  {error && (
                    <p id={errorId} className="text-sm text-destructive sm:col-span-full">
                      {error}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
          {atLimit && (
            <p className="text-sm text-muted-foreground">
              {t("chaptersLimit", { limit: MAX_CHAPTERS })}
            </p>
          )}
          <button
            type="button"
            disabled={atLimit}
            onClick={() => {
              const last = form.getValues("chapters").at(-1);
              const start = last ? Number(last.pageEnd) + 1 || 1 : 1;
              append(
                chapterValues({
                  title: "",
                  pageStart: start,
                  pageEnd: start,
                  topicId: null,
                }),
              );
            }}
            className={`${secondaryButton} self-start`}
          >
            <Plus aria-hidden="true" className="size-4" />
            {t("addChapter")}
          </button>
        </fieldset>

        <LiveNotice notice={shownNotice} />
        <SubmitButton
          pending={isSubmitting}
          label={t("save")}
          pendingLabel={t("saving")}
          className={`${primaryButton} self-start`}
        />
      </form>
    </section>
  );
}
