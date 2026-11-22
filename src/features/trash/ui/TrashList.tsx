"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocale, useTimeZone, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Clock, Lock, RotateCcw, Trash2 } from "lucide-react";
import { MathText } from "@/components/math/MathText";
import { formatBankDate } from "@/lib/format-date";
import { DEFAULT_TIMEZONE } from "@/lib/timezone-shared";
import type { TrashActionResult } from "../actions/action-support";
import { deleteAssessmentAction, restoreAssessmentAction } from "../actions/assessment";
import { deletePermanentlyAction } from "../actions/delete-permanently";
import {
  deleteFolderAction,
  deleteMaterialAction,
  restoreFolderAction,
  restoreMaterialAction,
} from "../actions/material";
import { restoreQuestionAction } from "../actions/restore";
import { deleteSolverSessionAction, restoreSolverSessionAction } from "../actions/solver";
import { deleteTemplateAction, restoreTemplateAction } from "../actions/template";
import type { TrashedAssessment } from "../service/assessment-trash";
import type { TrashedFolder, TrashedMaterial } from "../service/material-trash";
import type { TrashedSolverSession } from "../service/solver-trash";
import type { TrashedTemplate } from "../service/template-trash";
import type { TrashItem } from "../service/trash";
import { ConfirmDialog, dangerButtonClass, secondaryButtonClass } from "./ConfirmDialog";
import { useTrashErrorText, type TrashEntity } from "./error-key";

type Notice = { kind: "status" | "alert"; text: string } | null;

/** A button label from a problem excerpt: no maths delimiters, at most 60 characters. */
function plainLabel(text: string): string {
  const plain = text.replace(/\$/g, "").replace(/\s+/g, " ").trim();
  return plain.length > 60 ? `${plain.slice(0, 59)}…` : plain;
}

/** One row of the trash, whatever it holds: what it shows and what its buttons do. */
interface Row {
  key: string;
  entity: TrashEntity;
  content: ReactNode;
  deletedAt: string;
  daysLeft: number;
  /** Shown instead of the days left: the row is kept until something else goes first. */
  keptBecause?: string;
  restoreLabel: string;
  deleteLabel: string;
  restore: () => Promise<TrashActionResult>;
  deleteForever: () => Promise<TrashActionResult>;
  /** The announcement after a restore (it may depend on what the restore reports). */
  restored: (result: Extract<TrashActionResult, { ok: true }>) => string;
  deleted: string;
  confirmTitle: string;
  /** What a permanent delete takes, one line each. */
  confirmItems: string[];
  confirmNote?: string;
}

interface Section {
  key: string;
  heading: string;
  listLabel: string;
  rows: Row[];
}

/**
 * The trash: questions, assessments, templates, learning materials, their folders and solver
 * sessions, each kind
 * under its own heading, each row with
 * the days it has left, a restore button and a delete-for-good button behind a confirmation that
 * lists what goes. Outcomes are announced in one polite status region (errors in an alert), which
 * takes focus when the row it came from is gone.
 */
export function TrashList({
  items,
  assessments = [],
  templates = [],
  materials = [],
  folders = [],
  solverSessions = [],
}: {
  items: TrashItem[];
  assessments?: TrashedAssessment[];
  templates?: TrashedTemplate[];
  materials?: TrashedMaterial[];
  folders?: TrashedFolder[];
  solverSessions?: TrashedSolverSession[];
}) {
  const t = useTranslations("trash");
  const router = useRouter();
  const errorText = useTrashErrorText();
  const locale = useLocale();
  const view = { locale, timeZone: useTimeZone() ?? DEFAULT_TIMEZONE };
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirming, setConfirming] = useState<Row | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  // Set when an outcome should take focus. The move happens in an effect, after React has
  // committed: by then the modal dialog has left the document, so the region is no longer inert.
  const [focusNotice, setFocusNotice] = useState(0);

  useEffect(() => {
    if (focusNotice > 0 && confirming === null) noticeRef.current?.focus();
  }, [focusNotice, confirming]);

  const titles = (list: string[]) =>
    new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
      list.map((title) => `“${title}”`),
    );

  const questionRows: Row[] = items.map((item) => ({
    key: `question:${item.questionId}`,
    entity: "question",
    content: (
      <>
        <span className="min-w-0 font-heading font-semibold break-words">
          {item.topicTitle}
        </span>
        <MathText
          text={item.stemExcerptMd}
          className="block min-w-0 overflow-x-auto text-sm break-words"
        />
      </>
    ),
    deletedAt: item.deletedAt,
    daysLeft: item.daysLeft,
    keptBecause:
      item.pinnedBy.length > 0
        ? t("keptWhilePinned", { assessments: titles(item.pinnedBy) })
        : undefined,
    restoreLabel: t("restoreLabel", { topic: item.topicTitle }),
    deleteLabel: t("deleteForeverLabel", { topic: item.topicTitle }),
    restore: () => restoreQuestionAction({ questionId: item.questionId }),
    deleteForever: () => deletePermanentlyAction({ questionId: item.questionId }),
    restored: () => t("restored"),
    deleted: t("deleted"),
    confirmTitle: t("confirm.title"),
    confirmItems: [
      t("confirm.itemQuestion"),
      t("confirm.itemVersions", { count: item.versionCount }),
      t("confirm.itemRuns"),
    ],
  }));

  const assessmentRows: Row[] = assessments.map((item) => ({
    key: `assessment:${item.assessmentId}`,
    entity: "assessment",
    content: (
      <>
        <span className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 font-heading font-semibold break-words">
            {item.title}
          </span>
          {item.approved && (
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <Lock aria-hidden="true" className="size-4" />
              {t("assessment.approved")}
            </span>
          )}
        </span>
        <span className="text-sm text-muted-foreground">
          {t("assessment.summary", {
            items: item.itemCount,
            sections: item.sectionCount,
          })}
        </span>
      </>
    ),
    deletedAt: item.deletedAt,
    daysLeft: item.daysLeft,
    restoreLabel: t("assessment.restoreLabel", { title: item.title }),
    deleteLabel: t("assessment.deleteForeverLabel", { title: item.title }),
    restore: () => restoreAssessmentAction({ id: item.assessmentId }),
    deleteForever: () => deleteAssessmentAction({ id: item.assessmentId }),
    restored: () => t("assessment.restored"),
    deleted: t("assessment.deleted"),
    confirmTitle: t("assessment.confirm.title"),
    confirmItems: [
      t("assessment.confirm.itemAssessment"),
      t("assessment.confirm.itemContent", {
        sections: item.sectionCount,
        items: item.itemCount,
      }),
      t("assessment.confirm.itemExports", { count: item.exportCount }),
      t("assessment.confirm.itemUsages", { count: item.usageCount }),
    ],
    confirmNote: t("assessment.confirm.keep"),
  }));

  const templateRows: Row[] = templates.map((item) => ({
    key: `template:${item.templateId}`,
    entity: "template",
    content: (
      <>
        <span className="min-w-0 font-heading font-semibold break-words">
          {item.name}
        </span>
        <span className="text-sm break-words text-muted-foreground">
          {item.schoolName}
        </span>
        {item.usedBy.length > 0 && (
          <span className="text-sm break-words text-foreground">
            {t("template.usedBy", { assessments: titles(item.usedBy) })}
          </span>
        )}
      </>
    ),
    deletedAt: item.deletedAt,
    daysLeft: item.daysLeft,
    restoreLabel: t("template.restoreLabel", { name: item.name }),
    deleteLabel: t("template.deleteForeverLabel", { name: item.name }),
    restore: () => restoreTemplateAction({ id: item.templateId }),
    deleteForever: () => deleteTemplateAction({ id: item.templateId }),
    restored: (result) =>
      result.defaultDropped ? t("template.restoredNotDefault") : t("template.restored"),
    deleted: t("template.deleted"),
    confirmTitle: t("template.confirm.title"),
    confirmItems: [
      t("template.confirm.itemTemplate"),
      ...(item.hasLogo ? [t("template.confirm.itemLogo")] : []),
    ],
  }));

  const materialRows: Row[] = materials.map((item) => ({
    key: `material:${item.materialId}`,
    entity: "material",
    content: (
      <span className="min-w-0 font-heading font-semibold break-words">{item.title}</span>
    ),
    deletedAt: item.deletedAt,
    daysLeft: item.daysLeft,
    restoreLabel: t("material.restoreLabel", { title: item.title }),
    deleteLabel: t("material.deleteForeverLabel", { title: item.title }),
    restore: () => restoreMaterialAction({ id: item.materialId }),
    deleteForever: () => deleteMaterialAction({ id: item.materialId }),
    restored: () => t("material.restored"),
    deleted: t("material.deleted"),
    confirmTitle: t("material.confirm.title"),
    confirmItems: [
      t("material.confirm.itemFile"),
      ...(item.kind === "pdf" || item.kind === "image"
        ? [t("material.confirm.itemPageImages")]
        : []),
      t("material.confirm.itemText"),
      ...(item.sectionCount > 0
        ? [t("material.confirm.itemSections", { count: item.sectionCount })]
        : []),
    ],
    confirmNote: t("material.confirm.keep"),
  }));

  const folderRows: Row[] = folders.map((item) => ({
    key: `folder:${item.folderId}`,
    entity: "folder",
    content: (
      <span className="min-w-0 font-heading font-semibold break-words">{item.name}</span>
    ),
    deletedAt: item.deletedAt,
    daysLeft: item.daysLeft,
    restoreLabel: t("folder.restoreLabel", { name: item.name }),
    deleteLabel: t("folder.deleteForeverLabel", { name: item.name }),
    restore: () => restoreFolderAction({ id: item.folderId }),
    deleteForever: () => deleteFolderAction({ id: item.folderId }),
    restored: () => t("folder.restored"),
    deleted: t("folder.deleted"),
    confirmTitle: t("folder.confirm.title"),
    confirmItems: [t("folder.confirm.itemFolder")],
    confirmNote: t("folder.confirm.keep"),
  }));

  const solverRows: Row[] = solverSessions.map((item) => ({
    key: `solver_session:${item.sessionId}`,
    entity: "solver_session",
    content: (
      <MathText
        text={item.excerptMd || t("solverSession.untitled")}
        className="block min-w-0 font-heading font-semibold break-words"
      />
    ),
    deletedAt: item.deletedAt,
    daysLeft: item.daysLeft,
    restoreLabel: t("solverSession.restoreLabel", {
      problem: plainLabel(item.excerptMd),
    }),
    deleteLabel: t("solverSession.deleteForeverLabel", {
      problem: plainLabel(item.excerptMd),
    }),
    restore: () => restoreSolverSessionAction({ id: item.sessionId }),
    deleteForever: () => deleteSolverSessionAction({ id: item.sessionId }),
    restored: () => t("solverSession.restored"),
    deleted: t("solverSession.deleted"),
    confirmTitle: t("solverSession.confirm.title"),
    confirmItems: [
      t("solverSession.confirm.itemSession"),
      ...(item.solutionCount > 0
        ? [t("solverSession.confirm.itemSolutions", { count: item.solutionCount })]
        : []),
      ...(item.hasPhoto ? [t("solverSession.confirm.itemPhoto")] : []),
    ],
  }));

  const sections: Section[] = [
    {
      key: "questions",
      heading: t("sections.questions"),
      listLabel: t("listLabel"),
      rows: questionRows,
    },
    {
      key: "assessments",
      heading: t("sections.assessments"),
      listLabel: t("assessmentListLabel"),
      rows: assessmentRows,
    },
    {
      key: "templates",
      heading: t("sections.templates"),
      listLabel: t("templateListLabel"),
      rows: templateRows,
    },
    {
      key: "materials",
      heading: t("sections.materials"),
      listLabel: t("materialListLabel"),
      rows: materialRows,
    },
    {
      key: "folders",
      heading: t("sections.folders"),
      listLabel: t("folderListLabel"),
      rows: folderRows,
    },
    {
      key: "solverSessions",
      heading: t("sections.solverSessions"),
      listLabel: t("solverSessionListLabel"),
      rows: solverRows,
    },
  ].filter((section) => section.rows.length > 0);

  function settled(text: string) {
    setNotice({ kind: "status", text });
    // The row is about to go: keep focus on something that stays.
    setFocusNotice((n) => n + 1);
    router.refresh();
  }

  async function restore(row: Row) {
    setBusyKey(row.key);
    setNotice(null);
    const result = await row.restore();
    setBusyKey(null);
    if (!result.ok) {
      setNotice({ kind: "alert", text: errorText(result, row.entity) });
      return;
    }
    settled(row.restored(result));
  }

  async function deleteForever(row: Row) {
    setBusyKey(row.key);
    setConfirmError(null);
    const result = await row.deleteForever();
    setBusyKey(null);
    if (!result.ok) {
      setConfirmError(errorText(result, row.entity));
      return;
    }
    setConfirming(null);
    settled(row.deleted);
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p
        ref={noticeRef}
        tabIndex={-1}
        role={notice?.kind === "alert" ? "alert" : "status"}
        className={
          notice
            ? `rounded-lg border px-4 py-3 text-sm focus-visible:outline-none ${notice.kind === "alert" ? "border-destructive/40 text-destructive" : "border-border bg-card"}`
            : "sr-only"
        }
      >
        {notice?.text}
      </p>
      {sections.length === 0 ? (
        <div className="flex min-w-0 flex-col items-center gap-3 rounded-lg border bg-card px-6 py-12 text-center shadow-card">
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-lg bg-accent text-primary"
          >
            <Trash2 className="size-7" />
          </span>
          <p className="font-heading text-lg font-bold">{t("empty")}</p>
          <p className="max-w-sm text-sm text-muted-foreground">{t("emptyHint")}</p>
        </div>
      ) : (
        sections.map((section) => (
          <section key={section.key} className="flex min-w-0 flex-col gap-3">
            <h2 className="font-heading text-lg font-bold">{section.heading}</h2>
            <ul aria-label={section.listLabel} className="flex min-w-0 flex-col gap-3">
              {section.rows.map((row) => {
                const busy = busyKey === row.key;
                return (
                  <li
                    key={row.key}
                    className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 shadow-card"
                  >
                    {row.content}
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                      <span>
                        {t("deletedOn", { date: formatBankDate(row.deletedAt, view) })}
                      </span>
                      <span className="inline-flex items-center gap-1 font-medium text-foreground">
                        <Clock aria-hidden="true" className="size-4" />
                        {row.keptBecause ?? t("daysLeft", { days: row.daysLeft })}
                      </span>
                    </span>
                    <span className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                      <button
                        type="button"
                        disabled={busy}
                        aria-busy={busy}
                        aria-label={row.restoreLabel}
                        onClick={() => void restore(row)}
                        className={secondaryButtonClass}
                      >
                        <RotateCcw aria-hidden="true" className="size-4" />
                        {busy && !confirming ? t("restoring") : t("restore")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={row.deleteLabel}
                        onClick={(event) => {
                          openerRef.current = event.currentTarget;
                          setConfirmError(null);
                          setConfirming(row);
                        }}
                        className={dangerButtonClass}
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                        {t("deleteForever")}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
      {confirming && (
        <ConfirmDialog
          title={confirming.confirmTitle}
          confirmLabel={t("confirm.confirm")}
          workingLabel={t("confirm.working")}
          cancelLabel={t("confirm.cancel")}
          busy={busyKey === confirming.key}
          error={confirmError}
          onConfirm={() => void deleteForever(confirming)}
          onClosed={() => {
            setConfirming(null);
            openerRef.current?.focus();
          }}
        >
          <p>{t("confirm.description")}</p>
          <ul className="list-disc ps-5 text-foreground">
            {confirming.confirmItems.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {confirming.confirmNote && <p>{confirming.confirmNote}</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}
