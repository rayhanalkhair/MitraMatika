import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState, type SubmitEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { removeSectionAction, renameSectionAction } from "../actions/edit-sections";
import { ASSESSMENT_LIMITS } from "../schema/assessment";
import type { EditorSection } from "../service/editor-items";
import { ItemRow, sectionTitleId } from "./ItemRow";
import { control, iconButton, linkButton, secondaryButton } from "./styles";
import type { RunEditorAction } from "./use-editor-run";

/**
 * One section of the outline: its title (renamed in place), its items in order and the way to add
 * questions to it. `firstNumber` is the paper number of its first question.
 */
export function SectionEditor({
  section,
  sections,
  firstNumber,
  basePath,
  locked,
  busy,
  run,
}: {
  section: EditorSection;
  sections: { id: string; title: string }[];
  firstNumber: number;
  basePath: string;
  locked: boolean;
  busy: boolean;
  run: RunEditorAction;
}) {
  const t = useTranslations("assessments");
  const [title, setTitle] = useState(section.title);
  const [syncedTitle, setSyncedTitle] = useState(section.title);
  // A title saved (or changed in another tab) arrives from the server: show it.
  if (syncedTitle !== section.title) {
    setSyncedTitle(section.title);
    setTitle(section.title);
  }
  const off = locked || busy;
  const onlySection = sections.length === 1;

  function rename(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    run(() => renameSectionAction({ sectionId: section.id, title }), {
      done: t("section.renamed"),
      focus: [sectionTitleId(section.id)],
    });
  }

  return (
    <section
      aria-label={section.title}
      className="flex min-w-0 flex-col gap-3 rounded-lg border bg-muted/40 p-4"
    >
      <div className="flex flex-wrap items-end gap-2">
        <form onSubmit={rename} className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <label
              htmlFor={sectionTitleId(section.id)}
              className="font-heading text-sm font-semibold"
            >
              {t("section.titleLabel")}
            </label>
            <input
              id={sectionTitleId(section.id)}
              value={title}
              maxLength={ASSESSMENT_LIMITS.sectionTitle}
              disabled={off}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
              className={control}
            />
          </div>
          <button
            type="submit"
            disabled={off || title.trim() === "" || title.trim() === section.title}
            className={secondaryButton}
          >
            {t("section.rename")}
          </button>
        </form>
        <button
          type="button"
          disabled={off || onlySection}
          aria-label={t("section.removeNamed", { title: section.title })}
          title={t("section.removeHint")}
          onClick={() => {
            // The section goes away: the keyboard moves to the outline heading.
            run(() => removeSectionAction({ sectionId: section.id }), {
              done: t("section.removed"),
              focus: ["editor-outline"],
            });
          }}
          className={`${iconButton} text-destructive`}
        >
          <Trash2 aria-hidden="true" className="size-5" />
        </button>
      </div>

      {section.items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          {t("section.empty")}
        </p>
      ) : (
        <ol className="flex min-w-0 flex-col gap-3">
          {section.items.map((item, index) => (
            <ItemRow
              key={item.itemId}
              item={item}
              number={firstNumber + index}
              index={index}
              size={section.items.length}
              sections={sections}
              locked={locked}
              busy={busy}
              run={run}
            />
          ))}
        </ol>
      )}

      {!locked && (
        <Link
          href={`${basePath}?pick=${section.id}#picker`}

          className={linkButton}
        >
          <Plus aria-hidden="true" className="size-4" />
          {t("section.addQuestions")}
        </Link>
      )}
    </section>
  );
}
