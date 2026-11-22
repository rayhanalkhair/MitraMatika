import { useTranslations } from "next-intl";
import { useId, useState, type SubmitEvent } from "react";
import { Plus } from "lucide-react";
import { MathText } from "@/components/math/MathText";
import { addItemsAction } from "../actions/edit-items";
import { control, primaryButton } from "./styles";
import type { RunEditorAction } from "./use-editor-run";

export interface PickItem {
  questionId: string;
  stemExcerptMd: string;
  /** The line under the stem: topic, difficulty. */
  meta: string;
  added: boolean;
  /** Its newer version waits for its check: shown, but it cannot be added yet. */
  pending?: boolean;
}

/**
 * Checkable questions and the form that adds the checked ones to a section. Used by the picker
 * (the bank page) and by the offer after /generate. A question that is already in the assessment
 * is shown but cannot be checked.
 */
export function PickList({
  assessmentId,
  items,
  sections,
  initialSectionId,
  preselect = false,
  focusAfterAdd,
  locked,
  busy,
  run,
}: {
  assessmentId: string;
  items: PickItem[];
  sections: { id: string; title: string }[];
  initialSectionId: string;
  preselect?: boolean;
  /** The control that takes focus after an add (the add button is disabled by then). */
  focusAfterAdd: string;
  locked: boolean;
  busy: boolean;
  run: RunEditorAction;
}) {
  const t = useTranslations("assessments");
  const id = useId();
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(
        preselect
          ? items.filter((i) => !i.added && !i.pending).map((i) => i.questionId)
          : [],
      ),
  );
  const [target, setTarget] = useState(initialSectionId);
  // Only what can still be added counts (an item added meanwhile drops out of the selection).
  const addable = items.filter(
    (item) => !item.added && !item.pending && selected.has(item.questionId),
  );
  const off = locked || busy;

  function toggle(questionId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(questionId);
      else next.delete(questionId);
      return next;
    });
  }

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (addable.length === 0) return;
    const questionIds = addable.map((item) => item.questionId);
    run(() => addItemsAction({ assessmentId, sectionId: target, questionIds }), {
      done: (result) =>
        t("picker.result", {
          added: Number(result.added),
          skipped: Number(result.skipped),
        }),
      focus: [focusAfterAdd],
      // Only a successful add clears the checks: a refused one keeps them.
      onSuccess: () => {
        setSelected(new Set());
      },
      refused: (failure) => {
        const at = items.findIndex((item) => item.questionId === failure.questionId);
        if (at === -1) return null;
        if (failure.reason === "notBanked") {
          return t("picker.refusedNotBanked", { n: at + 1 });
        }
        if (failure.reason === "pendingCheck") {
          return t("picker.refusedPending", { n: at + 1 });
        }
        return null;
      },
    });
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-3">
      <ul className="flex min-w-0 flex-col gap-2">
        {items.map((item, index) => (
          <li key={item.questionId}>
            <label
              className={`flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 ${item.added || item.pending ? "opacity-70" : ""}`}
            >
              <input
                type="checkbox"
                aria-label={t("picker.select", { n: index + 1 })}
                checked={item.added || selected.has(item.questionId)}
                disabled={item.added || item.pending === true || off}
                onChange={(event) => {
                  toggle(item.questionId, event.target.checked);
                }}
                className="mt-1 size-5 shrink-0 accent-primary"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <MathText
                  text={item.stemExcerptMd}
                  className="block min-w-0 overflow-x-auto text-sm break-words"
                />
                <span className="text-sm text-muted-foreground">
                  {item.meta}
                  {item.added && ` · ${t("picker.alreadyAdded")}`}
                  {item.pending && ` · ${t("picker.pending")}`}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-3">
        {sections.length > 1 && (
          <div className="flex min-w-48 flex-col gap-1">
            <label
              htmlFor={`${id}-target`}
              className="text-sm font-medium text-muted-foreground"
            >
              {t("picker.targetLabel")}
            </label>
            <select
              id={`${id}-target`}
              value={target}
              disabled={off}
              onChange={(event) => {
                setTarget(event.target.value);
              }}
              className={control}
            >
              {sections.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.title}
                </option>
              ))}
            </select>
          </div>
        )}
        <button
          type="submit"
          disabled={off || addable.length === 0}
          className={primaryButton}
        >
          <Plus aria-hidden="true" className="size-4" />
          {busy ? t("picker.adding") : t("picker.add", { count: addable.length })}
        </button>
      </div>
    </form>
  );
}
