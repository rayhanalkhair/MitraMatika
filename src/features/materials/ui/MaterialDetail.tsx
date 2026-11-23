"use client";

import { useFormatter, useLocale, useTimeZone, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, type SubmitEvent } from "react";
import { StatusPill } from "@/components/ui/status-pill";
import { TrashMaterialButton } from "@/features/trash/ui/TrashMaterialButton";
import { formatBankDate } from "@/lib/format-date";
import { DEFAULT_TIMEZONE } from "@/lib/timezone-shared";
import { moveMaterialAction, type MoveMaterialState } from "../actions/move-material";
import type { FolderItem, MaterialDetail as Detail } from "../service/library";
import { fieldOf } from "./form-field";
import { formatSize } from "./format-size";
import { LiveNotice, type Notice } from "./LiveNotice";
import { STATUS_META, statusOf } from "./status-meta";
import { card, control, noticeClass, secondaryButton } from "./styles";

const TOP = "";
// A long list of page numbers stops here (the OCR review of Task 6 walks through all of them).
const FLAGGED_SHOWN = 30;

/**
 * What the teacher knows about one material: its file (type, size, pages, upload date), its status
 * in words, the text quality (decision 4: how many pages are clear, to check or hard to read, and
 * which ones), its folder (movable) and the move to the trash.
 */
export function MaterialDetail({
  detail,
  folders,
}: {
  detail: Omit<Detail, "proposal" | "sections">;
  folders: FolderItem[];
}) {
  const t = useTranslations("materials");
  const format = useFormatter();
  const locale = useLocale();
  const timeZone = useTimeZone() ?? DEFAULT_TIMEZONE;
  const router = useRouter();
  const id = useId();
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const status = statusOf(detail.status);
  const { tone, icon: StatusIcon } = STATUS_META[status];
  const kind =
    detail.kind === "docx" || detail.kind === "image" ? detail.kind : ("pdf" as const);

  async function move(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const folder = fieldOf(event.currentTarget, "folderId", TOP);
    setBusy(true);
    setNotice(null);
    let result: MoveMaterialState;
    try {
      result = await moveMaterialAction({
        materialId: detail.id,
        folderId: folder === TOP ? null : folder,
      });
    } catch {
      result = { ok: false, error: "generic" };
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setNotice({ kind: "alert", text: t(`detail.move.errors.${result.error}`) });
      return;
    }
    setNotice({ kind: "status", text: t("detail.move.moved") });
    router.refresh();
  }

  const top = folders.filter((folder) => folder.parentId === null);
  const childrenOf = (parentId: string) =>
    folders.filter((folder) => folder.parentId === parentId);

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <section aria-labelledby={`${id}-facts`} className={card}>
        <h2 id={`${id}-facts`} className="font-heading text-lg font-semibold">
          {t("detail.facts")}
        </h2>
        <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t("detail.statusLabel")}</dt>
          <dd>
            <StatusPill tone={tone}>
              <StatusIcon aria-hidden="true" className="size-4" />
              {t(`library.status.${status}`)}
            </StatusPill>
          </dd>
          <dt className="text-muted-foreground">{t("detail.kindLabel")}</dt>
          <dd>{t(`library.kind.${kind}`)}</dd>
          <dt className="text-muted-foreground">{t("detail.sizeLabel")}</dt>
          <dd>{formatSize(detail.sizeBytes, format)}</dd>
          {detail.pageImageBytes > 0 && (
            <>
              <dt className="text-muted-foreground">{t("detail.imagesLabel")}</dt>
              <dd>{formatSize(detail.pageImageBytes, format)}</dd>
            </>
          )}
          {detail.pageCount !== null && (
            <>
              <dt className="text-muted-foreground">{t("detail.pagesLabel")}</dt>
              <dd>{t("library.pages", { count: detail.pageCount })}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{t("detail.addedLabel")}</dt>
          <dd>{formatBankDate(detail.createdAt, { locale, timeZone })}</dd>
          <dt className="text-muted-foreground">{t("detail.folderLabel")}</dt>
          <dd className="break-words">{detail.folderName ?? t("detail.noFolder")}</dd>
        </dl>
        <p className="text-sm text-muted-foreground">{t("detail.sizeNote")}</p>
        <form
          onSubmit={(event) => void move(event)}
          className="flex min-w-0 flex-col gap-2"
        >
          {/* A label of its own, not one around the select: the name stays "Pindahkan ke folder"
              instead of also holding every option's text. */}
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`${id}-folder`} className="text-sm font-medium">
              {t("detail.move.label")}
            </label>
            <select
              id={`${id}-folder`}
              name="folderId"
              defaultValue={detail.folderId ?? TOP}
              className={control}
            >
              <option value={TOP}>{t("detail.noFolder")}</option>
              {top.map((folder) => (
                <optgroup key={folder.id} label={folder.name}>
                  <option value={folder.id}>{folder.name}</option>
                  {childrenOf(folder.id).map((child) => (
                    <option key={child.id} value={child.id}>
                      {`${folder.name} / ${child.name}`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={busy}
            className={`${secondaryButton} self-start`}
          >
            {t("detail.move.submit")}
          </button>
        </form>
        <LiveNotice notice={notice} />
        <TrashMaterialButton materialId={detail.id} title={detail.title} />
      </section>

      <section aria-labelledby={`${id}-quality`} className={card}>
        <h2 id={`${id}-quality`} className="font-heading text-lg font-semibold">
          {t("detail.quality.heading")}
        </h2>
        {status === "uploaded" || status === "processing" ? (
          <p className="text-sm">{t("detail.quality.reading")}</p>
        ) : status === "failed" ? (
          <p className={noticeClass("alert")}>{t("detail.quality.failed")}</p>
        ) : detail.pages.total === 0 ? (
          <p className="text-sm">{t("detail.quality.none")}</p>
        ) : (
          <>
            <p className="text-sm">
              {t("detail.quality.summary", {
                high: detail.pages.high,
                medium: detail.pages.medium,
                low: detail.pages.low,
              })}
            </p>
            {detail.flagReasons.length > 0 && (
              <p className="text-sm break-words">
                {t("detail.quality.reasons", {
                  reasons: detail.flagReasons
                    .map((flag) => t(`ocr.flags.${flag}`))
                    .join("; "),
                })}
              </p>
            )}
            {detail.flaggedPages.length > 0 && (
              <p className="text-sm break-words">
                {t("detail.quality.flagged", {
                  pages: new Intl.ListFormat(locale, {
                    style: "short",
                    type: "unit",
                  }).format([
                    ...detail.flaggedPages.slice(0, FLAGGED_SHOWN).map(String),
                    ...(detail.flaggedPages.length > FLAGGED_SHOWN ? ["…"] : []),
                  ]),
                })}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
