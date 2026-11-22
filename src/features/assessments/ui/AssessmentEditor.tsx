"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useId, useState, type SubmitEvent } from "react";
import { ArrowLeft, Eye, Lock, Plus, Sparkles } from "lucide-react";
import { StatusPill } from "@/components/ui/status-pill";
import type { BankList, BankQuery } from "@/features/bank";
import { addSectionAction } from "../actions/edit-sections";
import { ASSESSMENT_LIMITS } from "../schema/assessment";
import type { ApprovalState } from "../service/approval";
import type { AssessmentEditorView } from "../service/assessments";
import type { BankedSinceItem } from "../service/picker";
import { ApprovalPanel } from "./ApprovalPanel";
import { AssessmentForm, type TemplateOption } from "./AssessmentForm";
import { ItemPicker } from "./ItemPicker";
import { sectionTitleId } from "./ItemRow";
import { NewlyBanked } from "./NewlyBanked";
import { ScoringPanel } from "./ScoringPanel";
import { SectionEditor } from "./SectionEditor";
import { control, linkButton, secondaryButton } from "./styles";
import { useEditorRun } from "./use-editor-run";

export interface PickerData {
  sectionId: string;
  query: BankQuery;
  list: BankList;
  added: string[];
  pending: string[];
}

/**
 * The editor (a client island under the server page): details, the outline of sections and items,
 * the picker for the chosen section and the offer of newly banked questions. Every change goes
 * through a Server Action and then refreshes the page; the result is announced in a live region.
 * While the assessment is approved everything is read-only.
 */
export function AssessmentEditor({
  view,
  templates,
  generateHref,
  picker,
  offered,
  approval,
}: {
  view: AssessmentEditorView;
  templates: TemplateOption[];
  /** The link to /generate that comes back to this editor. */
  generateHref: string;
  picker: PickerData | null;
  offered: BankedSinceItem[];
  /** What blocks approval now, the hash of what the page shows, and the stored approval. */
  approval: ApprovalState;
}) {
  const t = useTranslations("assessments");
  const { assessment, sections } = view;
  const { pending, notice, problem, focusIds, clearFocus, run } = useEditorRun();
  const locked = assessment.status === "approved";
  const basePath = `/assessment-builder/${assessment.id}`;
  const outline = sections.map(({ id, title }) => ({ id, title }));
  const itemCount = sections.reduce((sum, section) => sum + section.items.length, 0);
  const scored = sections
    .flatMap((section) => section.items)
    .map((item, index) => ({
      itemId: item.itemId,
      number: index + 1,
      points: item.points,
    }));
  const headingId = useId();
  const addId = useId();
  const [newTitle, setNewTitle] = useState("");

  // After a refresh (or a refusal), put the keyboard back where it was: the first of the named
  // controls that exists and is enabled. The pressed button is disabled while the action runs and
  // may be gone afterwards, so without this focus would fall back to the page.
  useEffect(() => {
    if (pending || focusIds.length === 0) return;
    for (const id of focusIds) {
      const element = document.getElementById(id);
      if (element && !(element as HTMLButtonElement).disabled) {
        element.focus();
        clearFocus();
        return;
      }
    }
  }, [sections, pending, focusIds, clearFocus]);

  function addSection(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    run(() => addSectionAction({ assessmentId: assessment.id, title: newTitle }), {
      done: t("section.added"),
      // The new section's title is where the teacher goes on to type.
      focus: (result) => [sectionTitleId(String(result.id)), addId],
      // A refused add keeps the typed title.
      onSuccess: () => {
        setNewTitle("");
      },
    });
  }

  // The row version the teacher's last details save started from. The server's reply and the
  // refreshed page arrive in one render, which remounts the form before it could report back, so
  // the editor shows "saved" once the page carries a newer version than the one submitted. A
  // refused save does not change the version: the form stays mounted and shows its own error.
  const [submittedFrom, setSubmittedFrom] = useState<number | null>(null);
  const existingDetails = {
    title: assessment.title,
    kind: assessment.kind,
    grade: assessment.grade,
    templateId: assessment.templateId,
    examDate: assessment.examDate,
    durationMinutes: assessment.durationMinutes,
    instructions: assessment.instructions,
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/assessment-builder" className={linkButton}>
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("editor.back")}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`${basePath}/preview`} className={linkButton}>
            <Eye aria-hidden="true" className="size-4" />
            {t("editor.preview")}
          </Link>
          <StatusPill tone={locked ? "success" : "neutral"}>
            {locked && <Lock aria-hidden="true" className="size-4" />}
            {t(`list.status.${assessment.status}`)}
          </StatusPill>
          <span className="text-sm text-muted-foreground">
            {t("editor.total", { count: itemCount, sections: sections.length })}
          </span>
        </div>
      </div>

      {/* Always mounted: the result of the last change is announced when it appears. */}
      <div
        role="status"
        aria-live="polite"
        className="text-sm font-medium text-success-foreground empty:hidden"
      >
        {notice}
      </div>
      {problem && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive-soft p-3 text-sm font-medium text-destructive-foreground"
        >
          {problem}
        </p>
      )}
      {locked && (
        <p className="flex items-start gap-2 rounded-lg border border-success/30 bg-success-soft p-3 text-sm text-success-foreground">
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("editor.locked")}
        </p>
      )}

      <section
        aria-labelledby={`${headingId}-details`}
        className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-5 shadow-card"
      >
        <h2 id={`${headingId}-details`} className="font-heading text-lg font-bold">
          {t("editor.details")}
        </h2>
        <AssessmentForm
          // A newer row version remounts the form on the server's values, so a later save cannot
          // write stale fields over a change made elsewhere. The "saved" notice lives here, not in
          // the form, so the remount after the teacher's own save does not drop it.
          key={assessment.rowVersion}
          savedNotice={submittedFrom !== null && assessment.rowVersion > submittedFrom}
          onSubmitted={() => {
            setSubmittedFrom(assessment.rowVersion);
          }}
          templates={templates}
          assessmentId={assessment.id}
          rowVersion={assessment.rowVersion}
          disabled={locked}
          existing={existingDetails}
        />
      </section>

      {!locked && (
        <>
          <NewlyBanked
            assessmentId={assessment.id}
            basePath={basePath}
            offered={offered}
            sections={outline}
            locked={locked}
            busy={pending}
            run={run}
          />
        </>
      )}

      <section aria-labelledby="editor-outline" className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              id="editor-outline"
              tabIndex={-1}
              className="font-heading text-lg font-bold"
            >
              {t("editor.outline")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("editor.outlineHint")}</p>
          </div>
          {!locked && (
            <Link href={generateHref} className={secondaryButton}>
              <Sparkles aria-hidden="true" className="size-4" />
              {t("create.link")}
            </Link>
          )}
        </div>
        {!locked && <p className="text-sm text-muted-foreground">{t("create.hint")}</p>}

        {sections.map((section, index) => {
          const firstNumber =
            1 +
            sections
              .slice(0, index)
              .reduce((sum, earlier) => sum + earlier.items.length, 0);
          return (
            <SectionEditor
              key={section.id}
              section={section}
              sections={outline}
              firstNumber={firstNumber}
              basePath={basePath}
              locked={locked}
              busy={pending}
              run={run}
            />
          );
        })}

        {!locked && (
          <form onSubmit={addSection} className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-48 flex-1 flex-col gap-1">
              <label htmlFor={addId} className="font-heading text-sm font-semibold">
                {t("section.addLabel")}
              </label>
              <input
                id={addId}
                value={newTitle}
                maxLength={ASSESSMENT_LIMITS.sectionTitle}
                placeholder={t("section.addPlaceholder")}
                disabled={pending}
                onChange={(event) => {
                  setNewTitle(event.target.value);
                }}
                className={control}
              />
            </div>
            <button
              type="submit"
              disabled={pending || newTitle.trim() === ""}
              className={secondaryButton}
            >
              <Plus aria-hidden="true" className="size-4" />
              {t("section.add")}
            </button>
          </form>
        )}
      </section>

      {!locked && picker && (
        <ItemPicker
          assessmentId={assessment.id}
          basePath={basePath}
          sections={outline}
          pickSectionId={picker.sectionId}
          query={picker.query}
          list={picker.list}
          added={picker.added}
          pending={picker.pending}
          locked={locked}
          busy={pending}
          run={run}
        />
      )}

      <ScoringPanel
        assessmentId={assessment.id}
        mode={assessment.scoringMode}
        shuffled={assessment.shuffled}
        items={scored}
        locked={locked}
        busy={pending}
        run={run}
      />
      <ApprovalPanel
        assessmentId={assessment.id}
        state={approval}
        busy={pending}
        run={run}
      />
    </div>
  );
}
