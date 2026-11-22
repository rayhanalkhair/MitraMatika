import { useTranslations } from "next-intl";
import { AlertTriangle, ArrowDown, ArrowUp, RefreshCw, Trash2 } from "lucide-react";
import { MathText } from "@/components/math/MathText";
import { StatusPill } from "@/components/ui/status-pill";
import {
  moveItemAction,
  removeItemAction,
  updateItemToLatestAction,
} from "../actions/edit-items";
import type { EditorItem } from "../service/editor-items";
import type { RunEditorAction } from "./use-editor-run";
import { control, iconButton, secondaryButton } from "./styles";

/** The title input of a section: where focus goes when an item of it is removed. */
export const sectionTitleId = (sectionId: string) => `section-${sectionId}-title`;

/** The outline entry of an item: the approval panel links to it by number. */
export const itemAnchorId = (itemId: string) => `item-${itemId}`;

export const itemControlId = (itemId: string, control: "up" | "down" | "move") =>
  `item-${itemId}-${control}`;

/**
 * One question of the outline: its pinned content, what changed since it was pinned, and the
 * controls. The up and down buttons are always present (a keyboard and touch way to reorder); a
 * section select appears when there is more than one section. Everything is disabled while the
 * assessment is locked or an action runs.
 */
export function ItemRow({
  item,
  number,
  index,
  size,
  sections,
  locked,
  busy,
  run,
}: {
  item: EditorItem;
  /** 1-based position in the whole paper. */
  number: number;
  /** 0-based position in its section. */
  index: number;
  size: number;
  sections: { id: string; title: string }[];
  locked: boolean;
  busy: boolean;
  run: RunEditorAction;
}) {
  const t = useTranslations("assessments");
  const tr = useTranslations("review");
  const off = locked || busy;
  const id = (control: "up" | "down" | "move") => itemControlId(item.itemId, control);

  return (
    <li
      id={itemAnchorId(item.itemId)}
      // A link from the approval panel moves focus here.
      tabIndex={-1}
      aria-label={t("item.number", { n: number })}
      className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 shadow-card"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-heading font-bold">{t("item.number", { n: number })}</span>
        <span className="text-sm text-muted-foreground">
          {tr(`difficulty.${item.difficulty}`)}
        </span>
        <span className="text-sm text-muted-foreground">
          {t("item.version", { no: item.versionNo })}
        </span>
        {item.correctLabel && (
          <span className="text-sm text-muted-foreground">
            {t("item.correct", { label: item.correctLabel })}
          </span>
        )}
        {item.newerVersionAvailable && (
          <StatusPill tone="warning">
            <RefreshCw aria-hidden="true" className="size-4" />
            {t("item.newer")}
          </StatusPill>
        )}
      </div>

      <MathText
        text={item.stemMd}
        className="block min-w-0 overflow-x-auto text-sm break-words"
      />
      {item.options.length > 0 && (
        <ol className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-1 text-sm text-muted-foreground sm:grid-cols-2">
          {item.options.map((option) => (
            <li key={option.label} className="min-w-0 break-words">
              <span className="font-semibold">{option.label}. </span>
              <MathText text={option.textMd} />
            </li>
          ))}
        </ol>
      )}

      {item.state === "trashed" && (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive-soft p-3 text-sm text-destructive-foreground">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("item.trashed")}
        </p>
      )}
      {item.state === "pending" && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning-foreground">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("item.pending")}
        </p>
      )}
      {item.state === "unbanked" && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning-foreground">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("item.unbanked")}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          id={id("up")}
          aria-label={t("item.moveUp", { n: number })}
          disabled={off || index === 0}
          onClick={() => {
            run(
              () =>
                moveItemAction({
                  itemId: item.itemId,
                  toSectionId: item.sectionId,
                  toIndex: index - 1,
                }),
              { done: t("item.moved", { n: number - 1 }), focus: [id("up"), id("down")] },
            );
          }}
          className={iconButton}
        >
          <ArrowUp aria-hidden="true" className="size-5" />
        </button>
        <button
          type="button"
          id={id("down")}
          aria-label={t("item.moveDown", { n: number })}
          disabled={off || index === size - 1}
          onClick={() => {
            run(
              () =>
                moveItemAction({
                  itemId: item.itemId,
                  toSectionId: item.sectionId,
                  toIndex: index + 1,
                }),
              { done: t("item.moved", { n: number + 1 }), focus: [id("down"), id("up")] },
            );
          }}
          className={iconButton}
        >
          <ArrowDown aria-hidden="true" className="size-5" />
        </button>
        {sections.length > 1 && (
          <select
            id={id("move")}
            aria-label={t("item.moveTo", { n: number })}
            value={item.sectionId}
            disabled={off}
            onChange={(event) => {
              const toSectionId = event.target.value;
              if (toSectionId === item.sectionId) return;
              run(
                () =>
                  moveItemAction({
                    itemId: item.itemId,
                    toSectionId,
                    // Past the end: the server puts it last.
                    toIndex: Number.MAX_SAFE_INTEGER,
                  }),
                {
                  done: t("item.moved", { n: number }),
                  focus: [id("move"), id("up"), id("down")],
                },
              );
            }}
            className={`${control} w-auto max-w-56`}
          >
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.title}
              </option>
            ))}
          </select>
        )}
        {item.canUpdate && (
          <button
            type="button"
            disabled={off}
            aria-label={t("item.updateLatest", { n: number })}
            onClick={() => {
              run(() => updateItemToLatestAction({ itemId: item.itemId }), {
                done: (result) =>
                  result.changed === true
                    ? t("item.updatedNote")
                    : t("item.alreadyLatest"),
                focus: [id("up"), id("down")],
              });
            }}
            className={secondaryButton}
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            {t("item.updateLatest", { n: number })}
          </button>
        )}
        <button
          type="button"
          disabled={off}
          aria-label={t("item.remove", { n: number })}
          onClick={() => {
            // The row goes away: the keyboard moves to the title of its section.
            run(() => removeItemAction({ itemId: item.itemId }), {
              done: t("item.removedNote"),
              focus: [sectionTitleId(item.sectionId)],
            });
          }}
          className={`${iconButton} ml-auto text-destructive`}
        >
          <Trash2 aria-hidden="true" className="size-5" />
        </button>
      </div>
    </li>
  );
}
